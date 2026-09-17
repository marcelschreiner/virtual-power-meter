/**
 * Schlanke HTTP-API, ueber die die Messwerte in die virtuellen Zaehler kommen.
 * Bewusst ohne Framework - node:http reicht fuer ein halbes Dutzend Routen.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ApiConfig } from "./config.js";
import type { Bridge } from "./matter/bridge.js";
import type { MeterReading } from "./meter.js";
import type { SourceManager } from "./sources/manager.js";

const MAX_BODY_BYTES = 64 * 1024;

const READING_FIELDS = ["power", "voltage", "current", "energyImported", "energyExported"] as const;

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload, null, 2);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
    });
    response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request-Body ist zu gross");
        chunks.push(chunk as Buffer);
    }
    if (size === 0) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new HttpError(400, "Body ist kein gueltiges JSON");
    }
}

function parseReading(raw: unknown): MeterReading {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new HttpError(400, "Erwartet wird ein JSON-Objekt mit Messwerten");
    }
    const input = raw as Record<string, unknown>;
    const reading: MeterReading = {};
    let found = false;

    for (const field of READING_FIELDS) {
        const value = input[field];
        if (value === undefined || value === null) continue;
        if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new HttpError(400, `Feld "${field}" muss eine endliche Zahl sein`);
        }
        reading[field] = value;
        found = true;
    }

    if (!found) {
        throw new HttpError(400, `Kein bekanntes Feld gesetzt - erlaubt: ${READING_FIELDS.join(", ")}`);
    }
    if (reading.voltage !== undefined && reading.voltage < 0) {
        throw new HttpError(400, 'Feld "voltage" darf nicht negativ sein');
    }
    if (reading.energyImported !== undefined && reading.energyImported < 0) {
        throw new HttpError(400, 'Feld "energyImported" darf nicht negativ sein');
    }
    if (reading.energyExported !== undefined && reading.energyExported < 0) {
        throw new HttpError(400, 'Feld "energyExported" darf nicht negativ sein');
    }
    return reading;
}

function isAuthorized(request: IncomingMessage, token: string | undefined): boolean {
    if (token === undefined) return true;
    const header = request.headers.authorization;
    if (header?.startsWith("Bearer ") && header.slice(7) === token) return true;
    return request.headers["x-api-key"] === token;
}

export function createApiServer(config: ApiConfig, bridge: Bridge, sources?: SourceManager): Server {
    const server = createServer((request, response) => {
        handle(request, response, config, bridge, sources).catch(error => {
            if (error instanceof HttpError) {
                sendJson(response, error.status, { error: error.message });
            } else {
                console.error("Fehler in der HTTP-API:", error);
                sendJson(response, 500, { error: "Interner Fehler" });
            }
        });
    });
    return server;
}

async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    config: ApiConfig,
    bridge: Bridge,
    sources?: SourceManager,
): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method ?? "GET";

    if (path === "/health" || path === "/") {
        sendJson(response, 200, {
            status: "ok",
            meters: bridge.meters.size,
            commissioned: bridge.pairing().commissioned,
            ...(sources !== undefined ? { sources: sources.status } : {}),
        });
        return;
    }

    if (!path.startsWith("/api/")) {
        throw new HttpError(404, `Unbekannter Pfad ${path}`);
    }
    if (!isAuthorized(request, config.token)) {
        throw new HttpError(401, "Token fehlt oder ist falsch");
    }

    // Kontrollausgabe der Quellen: welches Geraet steuert wie viel zu welchem
    // Zaehler bei - das Gegenstueck zum `--list` der Python-Fassung.
    if (path === "/api/sources" && method === "GET") {
        if (sources === undefined) {
            sendJson(response, 200, { enabled: false, devices: [] });
            return;
        }
        sendJson(response, 200, { enabled: true, status: sources.status, devices: sources.devices });
        return;
    }

    if (path === "/api/commissioning" && method === "GET") {
        sendJson(response, 200, bridge.pairing());
        return;
    }

    if (path === "/api/meters") {
        if (method === "GET") {
            sendJson(response, 200, [...bridge.meters.values()].map(meter => meter.snapshot));
            return;
        }
        if (method === "POST") {
            await applyBulk(await readJsonBody(request), bridge);
            sendJson(response, 200, [...bridge.meters.values()].map(meter => meter.snapshot));
            return;
        }
        throw new HttpError(405, `${method} ist auf ${path} nicht erlaubt`);
    }

    const meterMatch = /^\/api\/meters\/([^/]+)$/.exec(path);
    if (meterMatch) {
        const id = decodeURIComponent(meterMatch[1] as string);
        const meter = bridge.meters.get(id);
        if (meter === undefined) throw new HttpError(404, `Zaehler "${id}" ist nicht konfiguriert`);

        if (method === "GET") {
            sendJson(response, 200, meter.snapshot);
            return;
        }
        if (method === "POST" || method === "PUT" || method === "PATCH") {
            await meter.applyReading(parseReading(await readJsonBody(request)));
            sendJson(response, 200, meter.snapshot);
            return;
        }
        throw new HttpError(405, `${method} ist auf ${path} nicht erlaubt`);
    }

    throw new HttpError(404, `Unbekannter Pfad ${path}`);
}

/**
 * Sammel-Update: entweder `{"<id>": {...}}` oder `[{"id": "...", ...}]`.
 * Praktisch, wenn eine Quelle alle Zaehler auf einmal liefert.
 */
async function applyBulk(body: unknown, bridge: Bridge): Promise<void> {
    const entries: Array<[string, unknown]> = [];

    if (Array.isArray(body)) {
        for (const item of body) {
            if (typeof item !== "object" || item === null || typeof (item as { id?: unknown }).id !== "string") {
                throw new HttpError(400, 'Jeder Eintrag der Liste braucht ein Feld "id"');
            }
            const { id, ...reading } = item as { id: string } & Record<string, unknown>;
            entries.push([id, reading]);
        }
    } else if (typeof body === "object" && body !== null) {
        entries.push(...Object.entries(body as Record<string, unknown>));
    } else {
        throw new HttpError(400, "Erwartet wird ein Objekt oder eine Liste");
    }

    if (entries.length === 0) throw new HttpError(400, "Keine Messwerte im Body");

    // Erst alles pruefen, dann anwenden - sonst bleibt bei einem Tippfehler
    // die Haelfte der Zaehler aktualisiert und die andere nicht.
    const validated = entries.map(([id, raw]) => {
        const meter = bridge.meters.get(id);
        if (meter === undefined) throw new HttpError(404, `Zaehler "${id}" ist nicht konfiguriert`);
        return { meter, reading: parseReading(raw) };
    });

    for (const { meter, reading } of validated) {
        await meter.applyReading(reading);
    }
}
