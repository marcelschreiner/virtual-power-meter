/**
 * Zugriff auf die Philips-Hue-Bridge.
 *
 * Nutzt die CLIP-v2-API und faellt auf die alte v1-API zurueck, falls die
 * Bridge zu alt ist. Kommt ohne externe Pakete aus.
 */
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { Xy } from "./model.js";

const TIMEOUT_MS = 5000;

export class HueError extends Error {}

/** Vereinheitlichter Lampenzustand, unabhaengig von der API-Version. */
export interface HueLight {
    id: string;
    name: string;
    modelId: string;
    productName: string;
    archetype: string;
    room: string;
    /** color | ct | dimmable | onoff */
    capability: string;
    on: boolean;
    /** 0..1 */
    brightness: number;
    mode: "xy" | "ct" | "none";
    xy?: Xy;
    mirek?: number;
    gradientXy: Xy[];
    reachable: boolean;
}

/**
 * Die Bridge benutzt im lokalen Netz ein selbstsigniertes Zertifikat. Es ist
 * keiner oeffentlichen CA bekannt, deshalb wird die Pruefung fuer Anfragen an
 * die Bridge bewusst abgeschaltet - fuer die Cloud-Suche bleibt sie an.
 */
async function requestJson(
    url: string,
    options: {
        method?: string;
        headers?: Record<string, string>;
        payload?: unknown;
        timeoutMs?: number;
        insecure?: boolean;
    } = {},
): Promise<unknown> {
    const { method = "GET", headers = {}, payload, timeoutMs = TIMEOUT_MS, insecure = false } = options;
    const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload), "utf8");

    const requestOptions: RequestOptions = {
        method,
        headers: {
            accept: "application/json",
            ...(body !== undefined ? { "content-type": "application/json", "content-length": body.length } : {}),
            ...headers,
        },
        rejectUnauthorized: !insecure,
    };

    const raw = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = httpsRequest(url, requestOptions, response => {
            const chunks: Buffer[] = [];
            response.on("data", chunk => chunks.push(chunk as Buffer));
            response.on("end", () =>
                resolve({
                    status: response.statusCode ?? 0,
                    text: Buffer.concat(chunks).toString("utf8"),
                }),
            );
        });
        req.setTimeout(timeoutMs, () => req.destroy(new HueError(`Zeitueberschreitung nach ${timeoutMs} ms`)));
        req.on("error", reject);
        if (body !== undefined) req.write(body);
        req.end();
    }).catch((error: unknown) => {
        if (error instanceof HueError) throw error;
        throw new HueError(`Bridge nicht erreichbar: ${String(error)}`);
    });

    if (raw.status === 401 || raw.status === 403) {
        throw new HueError(
            "Die Bridge weist den App-Key zurueck - VPM_HUE_APP_KEY pruefen (siehe README, Abschnitt \"App-Key besorgen\").",
        );
    }
    if (raw.status >= 400) {
        throw new HueError(`HTTP ${raw.status} von der Bridge (${url})`);
    }
    try {
        return JSON.parse(raw.text);
    } catch {
        throw new HueError("Unverstaendliche Antwort von der Bridge");
    }
}

export class HueBridge {
    name = "Hue Bridge";
    apiVersion: 1 | 2 = 2;

    readonly #ip: string;
    readonly #appKey: string;
    /** device-rid -> Stammdaten */
    #devices = new Map<string, { modelId: string; productName: string; archetype: string; name: string }>();
    /** light-rid -> device-rid */
    #lightOwner = new Map<string, string>();
    /** device-rid (v2) bzw. light-id (v1) -> Raumname */
    #rooms = new Map<string, string>();
    #lastStatic = 0;

    constructor(ip: string, appKey: string) {
        this.#ip = ip;
        this.#appKey = appKey;
    }

    get ip(): string {
        return this.#ip;
    }

    async #v2(resource: string): Promise<Array<Record<string, any>>> {
        const body = (await requestJson(`https://${this.#ip}/clip/v2/resource/${resource}`, {
            insecure: true,
            headers: { "hue-application-key": this.#appKey },
        })) as { data?: Array<Record<string, any>>; errors?: Array<{ description?: string }> };

        const errors = body.errors ?? [];
        if (errors.length > 0 && (body.data === undefined || body.data.length === 0)) {
            throw new HueError(errors[0]?.description ?? "Fehler von der Bridge");
        }
        return body.data ?? [];
    }

    async #v1(resource: string): Promise<Record<string, any>> {
        const body = await requestJson(`https://${this.#ip}/api/${this.#appKey}/${resource}`, { insecure: true });
        if (Array.isArray(body) && body.length > 0 && (body[0] as Record<string, any>)["error"] !== undefined) {
            throw new HueError((body[0] as Record<string, any>)["error"].description ?? "Fehler von der Bridge");
        }
        return body as Record<string, any>;
    }

    /** Stammdaten laden und die passende API-Version bestimmen. */
    async connect(): Promise<void> {
        try {
            await this.#loadStaticV2();
            this.apiVersion = 2;
        } catch (error) {
            const text = String(error);
            // Falscher Schluessel oder gar keine Verbindung - da hilft die alte
            // API auch nicht weiter.
            if (text.includes("App-Key") || text.includes("nicht erreichbar")) throw error;
            // Aeltere Firmware kennt CLIP v2 noch nicht.
            this.apiVersion = 1;
            await this.#loadStaticV1();
        }
    }

    async #loadStaticV2(): Promise<void> {
        const devices = await this.#v2("device");
        this.#devices.clear();
        this.#lightOwner.clear();

        for (const device of devices) {
            const productData = device["product_data"] ?? {};
            this.#devices.set(device["id"], {
                modelId: productData.model_id ?? "",
                productName: productData.product_name ?? "",
                archetype: productData.product_archetype ?? "",
                name: device["metadata"]?.name ?? "",
            });
            for (const service of device["services"] ?? []) {
                if (service.rtype === "light") this.#lightOwner.set(service.rid, device["id"]);
            }
            // Die Bridge selbst taucht als Geraet mit bridge-Service auf.
            if ((device["services"] ?? []).some((s: { rtype?: string }) => s.rtype === "bridge")) {
                this.name = device["metadata"]?.name || this.name;
            }
        }

        this.#rooms.clear();
        for (const room of await this.#v2("room")) {
            const label = room["metadata"]?.name ?? "";
            for (const child of room["children"] ?? []) {
                if (child.rtype === "device") this.#rooms.set(child.rid, label);
            }
        }
    }

    async #loadStaticV1(): Promise<void> {
        const config = await this.#v1("config");
        this.name = config["name"] ?? this.name;
        this.#rooms.clear();
        for (const group of Object.values(await this.#v1("groups")) as Array<Record<string, any>>) {
            if (group["type"] === "Room" || group["type"] === "Zone") {
                for (const lightId of group["lights"] ?? []) {
                    if (!this.#rooms.has(lightId)) this.#rooms.set(lightId, group["name"] ?? "");
                }
            }
        }
    }

    async poll(): Promise<HueLight[]> {
        return this.apiVersion === 2 ? this.#pollV2() : this.#pollV1();
    }

    async #pollV2(): Promise<HueLight[]> {
        const raw = await this.#v2("light");

        // Neue Lampe seit dem letzten Start? Stammdaten nachladen - aber
        // hoechstens einmal pro Minute, sonst dreht sich das bei einer Lampe
        // ohne Geraeteeintrag endlos.
        if (raw.some(item => !this.#lightOwner.has(item["id"]))) {
            const now = Date.now();
            if (now - this.#lastStatic > 60_000) {
                this.#lastStatic = now;
                await this.#loadStaticV2();
            }
        }

        const unreachable = new Set<string>();
        for (const zigbee of await this.#v2("zigbee_connectivity")) {
            const status = zigbee["status"];
            const owner = zigbee["owner"]?.rid;
            if (owner !== undefined && status !== undefined && status !== null && status !== "connected") {
                unreachable.add(owner);
            }
        }

        return raw.map(item => {
            const owner = this.#lightOwner.get(item["id"]) ?? "";
            const device = this.#devices.get(owner);
            const gradientPoints = (item["gradient"]?.points ?? []) as Array<Record<string, any>>;
            return {
                id: item["id"],
                name: item["metadata"]?.name || device?.name || "?",
                modelId: device?.modelId ?? "",
                productName: device?.productName ?? "",
                archetype: item["metadata"]?.archetype || device?.archetype || "",
                room: this.#rooms.get(owner) ?? "",
                capability: capabilityV2(item),
                on: Boolean(item["on"]?.on),
                brightness: Number(item["dimming"]?.brightness ?? 100) / 100,
                mode: modeV2(item),
                xy: toXy(item["color"]?.xy),
                mirek: item["color_temperature"]?.mirek ?? undefined,
                gradientXy: gradientPoints
                    .map(point => toXy(point["color"]?.xy))
                    .filter((xy): xy is Xy => xy !== undefined),
                reachable: !unreachable.has(owner),
            };
        });
    }

    async #pollV1(): Promise<HueLight[]> {
        const lights: HueLight[] = [];
        for (const [lightId, item] of Object.entries(await this.#v1("lights")) as Array<[string, Record<string, any>]>) {
            const state = item["state"] ?? {};
            const colormode = state.colormode ?? "";
            const xy = Array.isArray(state.xy) ? ([Number(state.xy[0]), Number(state.xy[1])] as Xy) : undefined;
            lights.push({
                id: lightId,
                name: item["name"] ?? "?",
                modelId: item["modelid"] ?? "",
                productName: item["productname"] ?? "",
                archetype: item["config"]?.archetype ?? "",
                room: this.#rooms.get(lightId) ?? "",
                capability: capabilityV1(item["type"] ?? ""),
                on: Boolean(state.on),
                brightness: Number(state.bri ?? 254) / 254,
                mode: colormode === "ct" ? "ct" : xy !== undefined ? "xy" : "none",
                xy,
                mirek: state.ct ?? undefined,
                gradientXy: [],
                reachable: state.reachable !== false,
            });
        }
        return lights;
    }
}

function capabilityV2(item: Record<string, any>): string {
    if (item["color"] !== undefined) return "color";
    if (item["color_temperature"] !== undefined) return "ct";
    if (item["dimming"] !== undefined) return "dimmable";
    return "onoff";
}

function capabilityV1(typeName: string): string {
    const t = typeName.toLowerCase();
    if (t.includes("color light") || t.includes("extended")) return "color";
    if (t.includes("temperature")) return "ct";
    if (t.includes("dimmable")) return "dimmable";
    return "onoff";
}

function modeV2(item: Record<string, any>): "xy" | "ct" | "none" {
    const ct = item["color_temperature"];
    if (ct?.mirek_valid === true && ct?.mirek) return "ct";
    if (item["color"]?.xy !== undefined) return "xy";
    return "none";
}

function toXy(xy: { x?: number; y?: number } | undefined): Xy | undefined {
    if (xy === undefined || xy === null) return undefined;
    return [Number(xy.x ?? 0), Number(xy.y ?? 0)];
}
