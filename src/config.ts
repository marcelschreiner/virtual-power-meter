/**
 * Konfiguration: JSON-Datei plus Environment-Overrides.
 *
 * Die JSON-Datei beschreibt die virtuellen Zaehler, die Umgebungsvariablen
 * decken das ab, was man im Container typischerweise ohne Datei-Mount setzen will.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { LampOverrides, SpeakerOverrides } from "./sources/catalog.js";

export type MeterKind = "meter" | "plug";

export interface SimulationConfig {
    enabled: boolean;
    /** Untere Grenze der simulierten Wirkleistung in Watt (darf negativ sein = Einspeisung). */
    minWatts: number;
    /** Obere Grenze der simulierten Wirkleistung in Watt. */
    maxWatts: number;
    /** Abstand zwischen zwei simulierten Messwerten in Sekunden. */
    intervalSeconds: number;
}

export interface MeterConfig {
    /** Stabile technische ID, wird fuer Matter-Endpoint und HTTP-API benutzt. */
    id: string;
    /** Anzeigename im Ecosystem (Home Assistant, Apple Home, ...). */
    name: string;
    /**
     * "meter" = Electrical Sensor (Matter-Geraetetyp 0x0510, der saubere Zaehler),
     * "plug"  = On/Off Plug-in Unit mit Messclustern, fuer Ecosysteme, die reine
     *           Utility-Geraete nicht anzeigen.
     */
    kind: MeterKind;
    /** Nennspannung in Volt, wird fuer die Stromberechnung benutzt. */
    nominalVoltage: number;
    /** 1 oder 3 Phasen - beeinflusst nur die berechnete Stromstaerke. */
    phases: 1 | 3;
    /** Startwert des Bezugszaehlers in kWh, falls noch kein Stand persistiert ist. */
    initialEnergyImportedKwh: number;
    /** Startwert des Einspeisezaehlers in kWh. */
    initialEnergyExportedKwh: number;
    simulation: SimulationConfig;
}

export interface BridgeConfig {
    name: string;
    vendorName: string;
    vendorId: number;
    productName: string;
    productId: number;
    serialNumber: string;
    passcode: number;
    discriminator: number;
    port: number;
}

export interface ApiConfig {
    enabled: boolean;
    host: string;
    port: number;
    /** Wenn gesetzt, verlangen alle /api/* Routen diesen Token. */
    token?: string;
}

/**
 * Philips Hue als Messquelle. Adresse und App-Key kommen normalerweise aus der
 * Umgebung (VPM_HUE_BRIDGE_IP, VPM_HUE_APP_KEY) - der App-Key ist ein Geheimnis
 * und hat in einer eingecheckten Konfigurationsdatei nichts verloren.
 */
export interface HueSourceConfig {
    enabled: boolean;
    bridgeIp: string;
    appKey: string;
    /** Eigenverbrauch der Bridge, als eigener Zaehler gefuehrt. */
    bridgeWatts: number;
    /** Exponent der Helligkeitskurve. */
    gamma: number;
    intervalSeconds: number;
    overrides: LampOverrides;
}

/** Sonos als Messquelle. Gefunden wird per SSDP, abgefragt per SOAP. */
export interface SonosSourceConfig {
    enabled: boolean;
    /** Feste Adressen statt Suche - noetig, wenn Multicast gesperrt ist. */
    ips: string[];
    /** Netzspannung fuer die Leerlaufwerte von Sonos. */
    mainsVoltage: "230" | "120";
    /** Aufschlag je USB-Netzwerkadapter an einem Era. */
    usbAdapterWatts: number;
    intervalSeconds: number;
    overrides: SpeakerOverrides;
}

export interface SourcesConfig {
    hue: HueSourceConfig;
    sonos: SonosSourceConfig;
}

export interface AppConfig {
    bridge: BridgeConfig;
    api: ApiConfig;
    meters: MeterConfig[];
    /** Quellen, die Zaehler selbst anlegen und fuellen. */
    sources: SourcesConfig;
    /** Verzeichnis fuer Matter-Fabric-Daten und Zaehlerstaende. */
    storagePath: string;
    /** Intervall, in dem Leistung zu Energie aufintegriert und persistiert wird. */
    integrationIntervalSeconds: number;
}

const DEFAULT_METER: Omit<MeterConfig, "id" | "name"> = {
    kind: "meter",
    nominalVoltage: 230,
    phases: 1,
    initialEnergyImportedKwh: 0,
    initialEnergyExportedKwh: 0,
    simulation: { enabled: false, minWatts: 0, maxWatts: 3000, intervalSeconds: 10 },
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$|^[a-z0-9]$/;

export class ConfigError extends Error {}

function envString(name: string): string | undefined {
    const value = process.env[name];
    return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function envNumber(name: string): number | undefined {
    const raw = envString(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new ConfigError(`${name} ist keine Zahl: "${raw}"`);
    return value;
}

function envBoolean(name: string): boolean | undefined {
    const raw = envString(name)?.toLowerCase();
    if (raw === undefined) return undefined;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    throw new ConfigError(`${name} ist kein Boolean: "${raw}"`);
}

function requireNumber(value: unknown, path: string, fallback: number): number {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ConfigError(`${path} muss eine Zahl sein`);
    }
    return value;
}

function parseMeter(raw: unknown, index: number): MeterConfig {
    if (typeof raw !== "object" || raw === null) {
        throw new ConfigError(`meters[${index}] muss ein Objekt sein`);
    }
    const input = raw as Record<string, unknown>;
    const id = typeof input.id === "string" ? input.id.trim() : "";
    if (!ID_PATTERN.test(id)) {
        throw new ConfigError(
            `meters[${index}].id "${id}" ist ungueltig - erlaubt sind Kleinbuchstaben, Ziffern und Bindestriche`,
        );
    }
    const kind = input.kind ?? DEFAULT_METER.kind;
    if (kind !== "meter" && kind !== "plug") {
        throw new ConfigError(`meters[${index}].kind muss "meter" oder "plug" sein`);
    }
    const phases = requireNumber(input.phases, `meters[${index}].phases`, DEFAULT_METER.phases);
    if (phases !== 1 && phases !== 3) {
        throw new ConfigError(`meters[${index}].phases muss 1 oder 3 sein`);
    }
    const nominalVoltage = requireNumber(
        input.nominalVoltage,
        `meters[${index}].nominalVoltage`,
        DEFAULT_METER.nominalVoltage,
    );
    if (nominalVoltage <= 0) {
        throw new ConfigError(`meters[${index}].nominalVoltage muss groesser als 0 sein`);
    }

    const simulationRaw = (input.simulation ?? {}) as Record<string, unknown>;
    const simulation: SimulationConfig = {
        enabled: simulationRaw.enabled === true,
        minWatts: requireNumber(simulationRaw.minWatts, `meters[${index}].simulation.minWatts`, DEFAULT_METER.simulation.minWatts),
        maxWatts: requireNumber(simulationRaw.maxWatts, `meters[${index}].simulation.maxWatts`, DEFAULT_METER.simulation.maxWatts),
        intervalSeconds: requireNumber(
            simulationRaw.intervalSeconds,
            `meters[${index}].simulation.intervalSeconds`,
            DEFAULT_METER.simulation.intervalSeconds,
        ),
    };
    if (simulation.minWatts > simulation.maxWatts) {
        throw new ConfigError(`meters[${index}].simulation.minWatts ist groesser als maxWatts`);
    }
    if (simulation.intervalSeconds < 1) {
        throw new ConfigError(`meters[${index}].simulation.intervalSeconds muss mindestens 1 sein`);
    }

    return {
        id,
        name: typeof input.name === "string" && input.name.trim() !== "" ? input.name.trim() : id,
        kind,
        nominalVoltage,
        phases,
        initialEnergyImportedKwh: requireNumber(
            input.initialEnergyImportedKwh,
            `meters[${index}].initialEnergyImportedKwh`,
            0,
        ),
        initialEnergyExportedKwh: requireNumber(
            input.initialEnergyExportedKwh,
            `meters[${index}].initialEnergyExportedKwh`,
            0,
        ),
        simulation,
    };
}

function defaultMeters(): MeterConfig[] {
    return [{ ...DEFAULT_METER, id: "meter-1", name: "Virtueller Stromzaehler" }];
}

function envList(name: string): string[] | undefined {
    const raw = envString(name);
    if (raw === undefined) return undefined;
    return raw
        .split(",")
        .map(entry => entry.trim())
        .filter(entry => entry !== "");
}

function parseSources(raw: unknown): SourcesConfig {
    const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const hueRaw = (input.hue ?? {}) as Record<string, unknown>;
    const sonosRaw = (input.sonos ?? {}) as Record<string, unknown>;

    const hueOverrides = (hueRaw.overrides ?? {}) as LampOverrides;
    const sonosOverrides = (sonosRaw.overrides ?? {}) as SpeakerOverrides;

    const mainsRaw = envString("VPM_SONOS_MAINS") ?? (sonosRaw.mainsVoltage as string | undefined);
    if (mainsRaw !== undefined && mainsRaw !== "230" && mainsRaw !== "120") {
        throw new ConfigError('sources.sonos.mainsVoltage muss "230" oder "120" sein');
    }

    const hue: HueSourceConfig = {
        enabled: envBoolean("VPM_HUE_ENABLED") ?? hueRaw.enabled === true,
        bridgeIp: envString("VPM_HUE_BRIDGE_IP") ?? (hueRaw.bridgeIp as string) ?? "",
        appKey: envString("VPM_HUE_APP_KEY") ?? (hueRaw.appKey as string) ?? "",
        bridgeWatts: envNumber("VPM_HUE_BRIDGE_WATTS") ?? requireNumber(hueRaw.bridgeWatts, "sources.hue.bridgeWatts", 1.9),
        gamma: envNumber("VPM_HUE_GAMMA") ?? requireNumber(hueRaw.gamma, "sources.hue.gamma", 2.0),
        // Unter 0.5 s faengt die Bridge an zu bremsen.
        intervalSeconds: Math.max(
            0.5,
            envNumber("VPM_HUE_INTERVAL") ?? requireNumber(hueRaw.intervalSeconds, "sources.hue.intervalSeconds", 2),
        ),
        overrides: hueOverrides,
    };

    const sonos: SonosSourceConfig = {
        enabled: envBoolean("VPM_SONOS_ENABLED") ?? sonosRaw.enabled === true,
        ips: envList("VPM_SONOS_IPS") ?? (Array.isArray(sonosRaw.ips) ? (sonosRaw.ips as string[]) : []),
        mainsVoltage: mainsRaw === "120" ? "120" : "230",
        usbAdapterWatts:
            envNumber("VPM_SONOS_USB_WATTS") ??
            requireNumber(sonosRaw.usbAdapterWatts, "sources.sonos.usbAdapterWatts", 0.5),
        // Je Player zwei Anfragen - deshalb traeger als die Bridge.
        intervalSeconds: Math.max(
            3,
            envNumber("VPM_SONOS_INTERVAL") ?? requireNumber(sonosRaw.intervalSeconds, "sources.sonos.intervalSeconds", 3),
        ),
        overrides: sonosOverrides,
    };

    if (hue.gamma <= 0) throw new ConfigError("sources.hue.gamma muss groesser als 0 sein");
    if (hue.bridgeWatts < 0) throw new ConfigError("sources.hue.bridgeWatts darf nicht negativ sein");
    if (sonos.usbAdapterWatts < 0) throw new ConfigError("sources.sonos.usbAdapterWatts darf nicht negativ sein");

    return { hue, sonos };
}

export async function loadConfig(): Promise<AppConfig> {
    const configPath = resolve(envString("VPM_CONFIG") ?? "config/meters.json");
    let fileContent: Record<string, unknown> = {};

    try {
        fileContent = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
            throw new ConfigError(`Konfiguration ${configPath} konnte nicht gelesen werden: ${String(error)}`);
        }
        // Ohne Datei laufen wir mit einem Default-Zaehler weiter - praktisch fuer den ersten Container-Start.
    }

    const bridgeRaw = (fileContent.bridge ?? {}) as Record<string, unknown>;
    const apiRaw = (fileContent.api ?? {}) as Record<string, unknown>;

    const sources = parseSources(fileContent.sources);
    const sourcesActive = sources.hue.enabled || sources.sonos.enabled;

    const metersRaw = fileContent.meters;
    // Quellen legen ihre Zaehler selbst an. Nur wenn gar nichts konfiguriert ist,
    // bekommt der erste Start einen Beispielzaehler, damit die Bridge nicht leer bleibt.
    const meters = Array.isArray(metersRaw)
        ? metersRaw.map(parseMeter)
        : sourcesActive
          ? []
          : defaultMeters();
    if (meters.length === 0 && !sourcesActive) meters.push(...defaultMeters());

    const seen = new Set<string>();
    for (const meter of meters) {
        if (seen.has(meter.id)) throw new ConfigError(`Doppelte Zaehler-ID "${meter.id}"`);
        seen.add(meter.id);
    }

    const bridge: BridgeConfig = {
        name: (bridgeRaw.name as string) ?? "Virtual Power Meter",
        vendorName: (bridgeRaw.vendorName as string) ?? "matter.js",
        // 0xFFF1 ist die von der CSA fuer Tests/Eigenbau reservierte Vendor-ID.
        vendorId: envNumber("VPM_VENDOR_ID") ?? requireNumber(bridgeRaw.vendorId, "bridge.vendorId", 0xfff1),
        productName: (bridgeRaw.productName as string) ?? "Virtual Power Meter Bridge",
        productId: envNumber("VPM_PRODUCT_ID") ?? requireNumber(bridgeRaw.productId, "bridge.productId", 0x8001),
        serialNumber: envString("VPM_SERIAL") ?? (bridgeRaw.serialNumber as string) ?? "vpm-0001",
        passcode: envNumber("VPM_PASSCODE") ?? requireNumber(bridgeRaw.passcode, "bridge.passcode", 20202021),
        discriminator:
            envNumber("VPM_DISCRIMINATOR") ?? requireNumber(bridgeRaw.discriminator, "bridge.discriminator", 3840),
        port: envNumber("VPM_MATTER_PORT") ?? requireNumber(bridgeRaw.port, "bridge.port", 5540),
    };

    if (bridge.discriminator < 0 || bridge.discriminator > 4095) {
        throw new ConfigError("bridge.discriminator muss zwischen 0 und 4095 liegen");
    }
    if (bridge.passcode < 1 || bridge.passcode > 99999998) {
        throw new ConfigError("bridge.passcode muss zwischen 1 und 99999998 liegen");
    }

    // Der Tick schreibt die Zaehlerstaende auf die Platte. Wer auf einem NAS mit
    // Festplatten laeuft, will das eher selten - die Genauigkeit haengt nicht
    // daran, weil bei jedem Messwert mit der echten Zeitdifferenz integriert wird.
    const integrationIntervalSeconds =
        envNumber("VPM_INTEGRATION_INTERVAL") ??
        requireNumber(fileContent.integrationIntervalSeconds, "integrationIntervalSeconds", 10);
    if (integrationIntervalSeconds <= 0) {
        throw new ConfigError("integrationIntervalSeconds muss groesser als 0 sein");
    }

    // `"token": null` in der JSON heisst "kein Token" - nicht "Token ist null".
    const fileToken = typeof apiRaw.token === "string" && apiRaw.token.trim() !== "" ? apiRaw.token.trim() : undefined;

    const api: ApiConfig = {
        enabled: envBoolean("VPM_API_ENABLED") ?? apiRaw.enabled !== false,
        host: envString("VPM_API_HOST") ?? (apiRaw.host as string) ?? "0.0.0.0",
        port: envNumber("VPM_API_PORT") ?? requireNumber(apiRaw.port, "api.port", 8080),
        token: envString("VPM_API_TOKEN") ?? fileToken,
    };

    return {
        bridge,
        api,
        meters,
        sources,
        storagePath: resolve(envString("VPM_STORAGE") ?? "data"),
        integrationIntervalSeconds,
    };
}
