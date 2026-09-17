/**
 * Sonos-Lautsprecher im Netz finden und ihren Zustand abfragen.
 *
 * Gefunden wird per SSDP (UPnP-Multicast), abgefragt per SOAP auf Port 1400.
 * Geschrieben wird nie etwas - nur GetZoneGroupState, GetTransportInfo und GetVolume.
 *
 * Wichtig: Sonos fuehrt die Wiedergabe pro *Gruppe*, nicht pro Geraet. Nur der
 * Koordinator einer Gruppe gibt darueber verlaesslich Auskunft; ein Stereopaar-
 * Partner oder ein zugeschaltetes Geraet meldet ueber sich selbst gern noch den
 * Zustand von vorhin. Deshalb wird zuerst die Gruppenstruktur gelesen und der
 * Wiedergabezustand dann vom Koordinator auf alle Mitglieder uebertragen.
 */
import { createSocket } from "node:dgram";
import { request as httpRequest } from "node:http";

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;
const SSDP_TARGET = "urn:schemas-upnp-org:device:ZonePlayer:1";
const SONOS_PORT = 1400;

// Ein Lautsprecher, der nicht binnen dieser Zeit antwortet, gilt als abwesend.
const REQUEST_TIMEOUT_MS = 1500;
const DISCOVERY_TIMEOUT_MS = 3000;
const REDISCOVER_EVERY_MS = 300_000;

/** Zustand eines Players. */
export interface SonosSpeaker {
    id: string;
    /** Raumname, den Sonos selbst vergibt. */
    name: string;
    room: string;
    /** z. B. "Sonos One" */
    model: string;
    modelNumber: string;
    ip: string;
    playing: boolean;
    muted: boolean;
    /** 0..1 */
    volume: number;
    transport: string;
    reachable: boolean;
    /** haengt am Netzwerkkabel */
    wired: boolean;
    /** ... obwohl das Modell gar keinen Anschluss hat */
    usbAdapter: boolean;
}

/**
 * Adresse eines Players. Sonos antwortet auf Port 1400; bringt der Aufrufer
 * bereits einen Port mit ("127.0.0.1:8080"), bleibt der stehen - das brauchen
 * die Tests, und es hilft, wenn ein Player hinter einer Portumleitung haengt.
 */
function baseUrl(ip: string): string {
    return ip.includes(":") ? `http://${ip}` : `http://${ip}:${SONOS_PORT}`;
}

async function httpText(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<string> {
    const { method = "GET", headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS } = options;
    const payload = body === undefined ? undefined : Buffer.from(body, "utf8");

    return new Promise<string>((resolve, reject) => {
        const req = httpRequest(
            url,
            {
                method,
                headers: {
                    ...(payload !== undefined ? { "content-length": payload.length } : {}),
                    ...headers,
                },
            },
            response => {
                const chunks: Buffer[] = [];
                response.on("data", chunk => chunks.push(chunk as Buffer));
                response.on("end", () => {
                    const status = response.statusCode ?? 0;
                    if (status >= 400) return reject(new Error(`HTTP ${status} von ${url}`));
                    resolve(Buffer.concat(chunks).toString("utf8"));
                });
            },
        );
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`Zeitueberschreitung nach ${timeoutMs} ms`)));
        req.on("error", reject);
        if (payload !== undefined) req.write(payload);
        req.end();
    });
}

/** IP-Adressen aller antwortenden Sonos-Player. */
export async function discoverSpeakers(timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<string[]> {
    const message = Buffer.from(
        [
            "M-SEARCH * HTTP/1.1",
            `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
            'MAN: "ssdp:discover"',
            "MX: 1",
            `ST: ${SSDP_TARGET}`,
            "",
            "",
        ].join("\r\n"),
        "utf8",
    );

    const found = new Set<string>();
    const socket = createSocket({ type: "udp4", reuseAddr: true });

    return new Promise<string[]>(resolve => {
        const finish = (): void => {
            clearTimeout(timer);
            try {
                socket.close();
            } catch {
                // Schon geschlossen - egal.
            }
            resolve([...found].sort());
        };
        const timer = setTimeout(finish, timeoutMs);

        socket.on("message", (data, remote) => {
            const text = data.toString("utf8");
            if (text.includes("ZonePlayer") || text.includes("Sonos")) found.add(remote.address);
        });
        // Multicast im eigenen Netz ist kein Grund, den ganzen Dienst zu stoppen.
        socket.on("error", () => finish());

        socket.bind(() => {
            try {
                socket.setMulticastTTL(2);
            } catch {
                // Manche Container erlauben das nicht - dann bleibt es bei TTL 1.
            }
            // Mehrfach senden: UDP-Multicast geht gern mal verloren.
            for (let i = 0; i < 3; i++) socket.send(message, SSDP_PORT, SSDP_ADDR);
        });
    });
}

/** Stammdaten eines Players aus seiner Geraetebeschreibung lesen. */
export async function describe(ip: string): Promise<SonosSpeaker | undefined> {
    let xml: string;
    try {
        xml = await httpText(`${baseUrl(ip)}/xml/device_description.xml`);
    } catch {
        return undefined;
    }

    const room = firstTag(xml, "roomName");
    if (room === "") return undefined;

    return {
        id: (firstTag(xml, "UDN") || `uuid:${ip}`).replace("uuid:", ""),
        name: room,
        room,
        model: firstTag(xml, "modelName"),
        modelNumber: firstTag(xml, "modelNumber"),
        ip,
        playing: false,
        muted: false,
        volume: 0,
        transport: "STOPPED",
        reachable: true,
        // Nur bei der Suche ermitteln - die Verbindungsart aendert sich selten.
        wired: await readWired(ip),
        usbAdapter: false,
    };
}

/**
 * Haengt der Player am Kabel?
 *
 * Sonos legt unter `/status/ifconfig` die Ausgabe von ifconfig offen. Ein
 * benutztes Kabel zeigt sich an einer laufenden eth-Schnittstelle, ueber die
 * tatsaechlich Daten gegangen sind - ungenutzte stehen auf 0. Der Endpunkt ist
 * nicht dokumentiert, deshalb gilt hier: im Zweifel nein.
 */
export async function readWired(ip: string): Promise<boolean> {
    let text: string;
    try {
        text = (await httpText(`${baseUrl(ip)}/status/ifconfig`)).replace(/<[^>]+>/g, "");
    } catch {
        return false;
    }

    for (const block of text.split(/\n(?=\S)/)) {
        if (!/^eth\d+\s+Link encap/.test(block.trim())) continue;
        if (!block.includes("RUNNING")) continue;
        const received = /RX bytes:(\d+)/.exec(block);
        if (received !== null && Number(received[1]) > 0) return true;
    }
    return false;
}

async function soap(ip: string, path: string, service: string, action: string, body = ""): Promise<string> {
    const envelope =
        '<?xml version="1.0"?>' +
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
        `<u:${action} xmlns:u="${service}">${body}</u:${action}>` +
        "</s:Body></s:Envelope>";

    return httpText(`${baseUrl(ip)}${path}`, {
        method: "POST",
        body: envelope,
        headers: { "content-type": 'text/xml; charset="utf-8"', soapaction: `"${service}#${action}"` },
    });
}

const AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1";
const RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:1";
const ZONE_GROUP_TOPOLOGY = "urn:schemas-upnp-org:service:ZoneGroupTopology:1";

/** Eine Sonos-Gruppe. Der Koordinator bestimmt, was gespielt wird. */
export interface ZoneGroup {
    /** UUID des Koordinators, z. B. "RINCON_000000000001400". */
    coordinator: string;
    /** UUIDs aller Mitglieder, den Koordinator eingeschlossen. */
    members: string[];
}

/**
 * Gruppenstruktur des Systems. Jeder Player kennt sie vollstaendig, es genuegt
 * also, einen beliebigen zu fragen. Bei einem Fehler kommt eine leere Liste
 * zurueck - dann faellt die Abfrage auf die Auskunft der einzelnen Geraete
 * zurueck, was ungenauer, aber besser als nichts ist.
 */
export async function readZoneGroups(ip: string): Promise<ZoneGroup[]> {
    let response: string;
    try {
        response = await soap(ip, "/ZoneGroupTopology/Control", ZONE_GROUP_TOPOLOGY, "GetZoneGroupState");
    } catch {
        return [];
    }

    // Die Antwort traegt die eigentliche Struktur als maskiertes XML im Text.
    const inner = unescapeXml(firstTag(response, "ZoneGroupState"));
    const groups: ZoneGroup[] = [];

    for (const block of inner.match(/<ZoneGroup\b[\s\S]*?<\/ZoneGroup>/g) ?? []) {
        const coordinator = attribute(block, "Coordinator");
        if (coordinator === undefined) continue;

        const members: string[] = [];
        // Satelliten (Sub, Surrounds) haengen am selben Koordinator.
        for (const element of block.match(/<(?:ZoneGroupMember|Satellite)\b[^>]*>/g) ?? []) {
            const uuid = attribute(element, "UUID");
            if (uuid !== undefined) members.push(uuid);
        }
        groups.push({ coordinator, members });
    }
    return groups;
}

/** Wiedergabezustand eines Players. Nur beim Koordinator aussagekraeftig. */
export async function readTransport(ip: string): Promise<string | undefined> {
    try {
        const response = await soap(ip, "/MediaRenderer/AVTransport/Control", AV_TRANSPORT, "GetTransportInfo", "<InstanceID>0</InstanceID>");
        return firstTag(response, "CurrentTransportState") || "STOPPED";
    } catch {
        return undefined;
    }
}

/** Lautstaerke eines Players, 0..1. Die zaehlt pro Geraet, nicht pro Gruppe. */
export async function readVolume(ip: string): Promise<number | undefined> {
    try {
        const response = await soap(ip, "/MediaRenderer/RenderingControl/Control", RENDERING_CONTROL, "GetVolume", "<InstanceID>0</InstanceID><Channel>Master</Channel>");
        const level = Number.parseInt(firstTag(response, "CurrentVolume") || "0", 10);
        return Number.isFinite(level) ? Math.min(Math.max(level / 100, 0), 1) : 0;
    } catch {
        return undefined;
    }
}

function attribute(element: string, name: string): string | undefined {
    return new RegExp(`\\b${name}="([^"]*)"`).exec(element)?.[1];
}

function unescapeXml(text: string): string {
    return text
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll("&amp;", "&");
}

function firstTag(xml: string, name: string): string {
    const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
    return match?.[1]?.trim() ?? "";
}

/** Mehrere Anfragen parallel, aber nicht unbegrenzt - ein Netz ist kein Bus. */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (let index = next++; index < items.length; index = next++) {
            results[index] = await worker(items[index] as T);
        }
    });
    await Promise.all(runners);
    return results;
}

/** Haelt die Liste der Player aktuell und fragt sie parallel ab. */
export class SonosSystem {
    error: string | undefined;

    readonly #manualIps: string[];
    readonly #minIntervalMs: number;
    #speakers: SonosSpeaker[] = [];
    #lastPoll = 0;
    #lastDiscovery = 0;
    #scanning = false;
    #groupCount = 0;

    constructor(manualIps: string[] = [], minIntervalMs = 3000) {
        this.#manualIps = manualIps;
        this.#minIntervalMs = minIntervalMs;
    }

    /** Erste Suche - laeuft einmal vor dem Anlegen der Zaehler. */
    async start(): Promise<number> {
        await this.#scan();
        return this.#speakers.length;
    }

    get speakers(): SonosSpeaker[] {
        return this.#speakers;
    }

    async #scan(): Promise<void> {
        const ips = this.#manualIps.length > 0 ? this.#manualIps : await discoverSpeakers();
        this.#lastDiscovery = Date.now();

        if (ips.length === 0) {
            if (this.#speakers.length === 0) {
                this.error =
                    "keine Sonos-Geraete gefunden - Multicast im Netz erlaubt? Sonst Adressen in der Konfiguration angeben";
            }
            return;
        }

        const known = new Map(this.#speakers.map(speaker => [speaker.ip, speaker]));
        const described = await mapLimit(ips, 8, describe);

        const fresh: SonosSpeaker[] = [];
        for (const [index, ip] of ips.entries()) {
            const entry = described[index];
            if (entry === undefined) {
                // Nicht erreichbar: bekannten Eintrag behalten, sonst ueberspringen.
                const previous = known.get(ip);
                if (previous !== undefined) fresh.push(previous);
                continue;
            }
            const previous = known.get(ip);
            if (previous !== undefined) {
                // Zustand des bekannten Players uebernehmen, Stammdaten auffrischen.
                entry.playing = previous.playing;
                entry.volume = previous.volume;
                entry.transport = previous.transport;
                entry.usbAdapter = previous.usbAdapter;
            }
            fresh.push(entry);
        }

        this.#speakers = fresh.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
        if (fresh.length > 0) this.error = undefined;
    }

    /** Nachsuche im Hintergrund, damit die Abfrage nicht stehenbleibt. */
    #scanInBackground(): void {
        if (this.#scanning) return;
        this.#scanning = true;
        void this.#scan()
            .catch(() => undefined)
            .finally(() => {
                this.#scanning = false;
            });
    }

    async poll(): Promise<SonosSpeaker[]> {
        const now = Date.now();
        if (this.#manualIps.length === 0 && now - this.#lastDiscovery > REDISCOVER_EVERY_MS) {
            this.#scanInBackground();
        }

        // Lautsprecher seltener abfragen als Lampen: je Player mehrere Anfragen.
        if (this.#speakers.length > 0 && now - this.#lastPoll >= this.#minIntervalMs) {
            this.#lastPoll = now;
            this.#speakers = await this.#refresh(this.#speakers);
        }
        return this.#speakers;
    }

    /** Anzahl der erkannten Gruppen; 0 heisst: die Struktur war nicht zu lesen. */
    get groupCount(): number {
        return this.#groupCount;
    }

    async #refresh(speakers: SonosSpeaker[]): Promise<SonosSpeaker[]> {
        // Die Gruppenstruktur kennt jeder Player - der erste, der antwortet, genuegt.
        let groups: ZoneGroup[] = [];
        for (const speaker of speakers) {
            groups = await readZoneGroups(speaker.ip);
            if (groups.length > 0) break;
        }
        this.#groupCount = groups.length;

        const coordinatorOf = new Map<string, string>();
        for (const group of groups) {
            for (const member of group.members) coordinatorOf.set(member, group.coordinator);
        }

        const byUuid = new Map(speakers.map(speaker => [speaker.id, speaker]));
        /**
         * Wen fragen wir nach dem Wiedergabezustand? Den Koordinator der Gruppe -
         * und nur dann den Player selbst, wenn die Struktur unbekannt ist oder
         * der Koordinator gar nicht gefunden wurde.
         */
        const sourceOf = (speaker: SonosSpeaker): string => {
            const coordinator = coordinatorOf.get(speaker.id);
            return coordinator !== undefined && byUuid.has(coordinator) ? coordinator : speaker.id;
        };

        const transports = new Map<string, string>();
        const asked = [...new Set(speakers.map(sourceOf))];
        await mapLimit(asked, 8, async uuid => {
            const source = byUuid.get(uuid);
            if (source === undefined) return;
            const state = await readTransport(source.ip);
            if (state !== undefined) transports.set(uuid, state);
        });

        return mapLimit(speakers, 8, async speaker => {
            const volume = await readVolume(speaker.ip);
            if (volume === undefined) {
                return { ...speaker, reachable: false, playing: false };
            }
            const transport = transports.get(sourceOf(speaker)) ?? "STOPPED";
            return {
                ...speaker,
                reachable: true,
                transport,
                playing: transport === "PLAYING",
                volume,
                // Ein stummer Player verstaerkt nichts, auch wenn die Gruppe laeuft.
                muted: volume <= 0,
            };
        });
    }
}
