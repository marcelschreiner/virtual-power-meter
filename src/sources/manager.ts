/**
 * Die Messquellen: Philips Hue und Sonos.
 *
 * Beide werden regelmaessig abgefragt, jedes Geraet einzeln geschaetzt und das
 * Ergebnis pro Raum aufsummiert (`aggregate.ts`). Je Raum entsteht ein
 * virtueller Zaehler - einer fuer das Licht, einer fuer den Ton - dazu ein
 * einzelner Zaehler fuer die Grundlast der Hue-Bridge.
 *
 * Geschaetzt, nicht gemessen: das Modell steht in `model.ts`, die Zahlen dahinter
 * in `data/lamp-models.json` und `data/speaker-models.json`.
 */
import { Logger } from "@matter/main";
import type { AppConfig, MeterConfig } from "../config.js";
import type { Bridge } from "../matter/bridge.js";
import type { VirtualMeter } from "../meter.js";
import { aggregateLamps, aggregateSpeakers, round, type DeviceReport, type RoomTotal } from "./aggregate.js";
import { LampCatalog, SpeakerCatalog } from "./catalog.js";
import { HueBridge, type HueLight } from "./hue.js";
import { meterIdFor } from "./naming.js";
import { KnownMeterStore, type MeterOrigin } from "./registry.js";
import { SonosSystem } from "./sonos.js";

const logger = Logger.get("Sources");

/** Zaehler-ID der Bridge-Grundlast - fest, weil es nur eine Bridge gibt. */
const HUE_BRIDGE_METER_ID = "hue-bridge";

/** Nennspannung der Hue-Zaehler; nur fuer die abgeleitete Stromstaerke relevant. */
const HUE_NOMINAL_VOLTAGE = 230;

export interface SourceStatus {
    hue: {
        enabled: boolean;
        connected: boolean;
        bridgeName?: string;
        apiVersion?: number;
        lights: number;
        rooms: number;
        error?: string;
        lastUpdate?: string;
    };
    sonos: {
        enabled: boolean;
        speakers: number;
        rooms: number;
        /** Erkannte Sonos-Gruppen. 0 heisst: die Struktur war nicht zu lesen und
         *  der Wiedergabezustand kommt aus der weniger verlaesslichen Einzelauskunft. */
        groups: number;
        error?: string;
        lastUpdate?: string;
    };
}

/** Vorlage fuer einen von einer Quelle angelegten Zaehler. */
function meterConfigFor(id: string, name: string, nominalVoltage: number): MeterConfig {
    return {
        id,
        name,
        kind: "meter",
        nominalVoltage,
        phases: 1,
        initialEnergyImportedKwh: 0,
        initialEnergyExportedKwh: 0,
        simulation: { enabled: false, minWatts: 0, maxWatts: 0, intervalSeconds: 10 },
    };
}

export class SourceManager {
    readonly #config: AppConfig;
    readonly #bridge: Bridge;
    readonly #registry: KnownMeterStore;

    #lampCatalog?: LampCatalog;
    #speakerCatalog?: SpeakerCatalog;
    #hue?: HueBridge;
    #sonos?: SonosSystem;

    #hueTimer?: NodeJS.Timeout;
    #sonosTimer?: NodeJS.Timeout;
    #hueBusy = false;
    #sonosBusy = false;
    #stopped = false;

    /** Zaehler-ID -> Raumname, getrennt nach Quelle, damit leere Raeume auf 0 fallen. */
    readonly #hueMeters = new Map<string, string>();
    readonly #sonosMeters = new Map<string, string>();
    /** Zaehler, deren Anlegen gescheitert ist - einmal melden, dann in Ruhe lassen. */
    readonly #broken = new Set<string>();

    #devices: DeviceReport[] = [];
    #status: SourceStatus = {
        hue: { enabled: false, connected: false, lights: 0, rooms: 0 },
        sonos: { enabled: false, speakers: 0, rooms: 0, groups: 0 },
    };

    constructor(config: AppConfig, bridge: Bridge) {
        this.#config = config;
        this.#bridge = bridge;
        this.#registry = new KnownMeterStore(config.storagePath);
    }

    get devices(): DeviceReport[] {
        return this.#devices;
    }

    get status(): SourceStatus {
        return this.#status;
    }

    /**
     * Bereits bekannte Zaehler wiederherstellen - vor dem Start des Knotens,
     * damit die Geraete im Controller nicht kurz verschwinden, wenn Hue oder
     * Sonos beim Start gerade nicht antworten.
     */
    async prepare(): Promise<void> {
        const { hue, sonos } = this.#config.sources;
        this.#status.hue.enabled = hue.enabled;
        this.#status.sonos.enabled = sonos.enabled;

        await this.#registry.load();
        let restored = 0;
        for (const known of this.#registry.list()) {
            if (known.origin === "sonos" ? !sonos.enabled : !hue.enabled) continue;
            const voltage = known.origin === "sonos" ? Number(sonos.mainsVoltage) : HUE_NOMINAL_VOLTAGE;
            await this.#bridge.addMeter(meterConfigFor(known.id, known.name, voltage));
            if (known.origin === "hue") this.#hueMeters.set(known.id, known.room);
            if (known.origin === "sonos") this.#sonosMeters.set(known.id, known.room);
            restored++;
        }

        if (restored > 0) logger.info(`${restored} Zaehler aus ${this.#registry.path} wiederhergestellt.`);
    }

    /** Quellen verbinden, einmal abfragen und danach regelmaessig weiterfragen. */
    async start(): Promise<void> {
        const { hue, sonos } = this.#config.sources;

        if (hue.enabled) {
            this.#lampCatalog = await LampCatalog.load(hue.overrides);
            await this.#connectHue();
        }
        if (sonos.enabled) {
            this.#speakerCatalog = await SpeakerCatalog.load(sonos.overrides, sonos.mainsVoltage);
            this.#sonos = new SonosSystem(sonos.ips, sonos.intervalSeconds * 1000);
            const count = await this.#sonos.start();
            logger.notice(
                count > 0
                    ? `${count} Sonos-Geraet(e) gefunden.`
                    : "Keine Sonos-Geraete gefunden - Multicast im Netz erlaubt?",
            );
        }

        // Einmal sofort, damit die Zaehler nicht erst nach dem ersten Intervall Werte tragen.
        await this.#pollHue();
        await this.#pollSonos();

        if (this.#hue !== undefined) {
            this.#hueTimer = setInterval(() => void this.#pollHue(), hue.intervalSeconds * 1000);
        }
        if (this.#sonos !== undefined) {
            this.#sonosTimer = setInterval(() => void this.#pollSonos(), sonos.intervalSeconds * 1000);
        }
    }

    async stop(): Promise<void> {
        this.#stopped = true;
        if (this.#hueTimer !== undefined) clearInterval(this.#hueTimer);
        if (this.#sonosTimer !== undefined) clearInterval(this.#sonosTimer);
        // Laufende Abfragen kurz auslaufen lassen, damit kein halber Schreibvorgang bleibt.
        for (let waited = 0; (this.#hueBusy || this.#sonosBusy) && waited < 3000; waited += 50) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }

    async #connectHue(): Promise<void> {
        const { bridgeIp, appKey } = this.#config.sources.hue;

        if (bridgeIp === "" || appKey === "") {
            // Genau sagen, was fehlt - beides kommt aus der Umgebung bzw. der
            // Konfigurationsdatei, es gibt keinen zweiten Weg.
            const missing = [
                bridgeIp === "" ? "VPM_HUE_BRIDGE_IP" : undefined,
                appKey === "" ? "VPM_HUE_APP_KEY" : undefined,
            ].filter(entry => entry !== undefined);
            this.#status.hue.error =
                `Hue ist aktiviert, aber ${missing.join(" und ")} fehlt. ` +
                "App-Key besorgen: siehe README, Abschnitt \"App-Key besorgen\".";
            logger.warn(this.#status.hue.error);
            return;
        }

        const client = new HueBridge(bridgeIp, appKey);
        try {
            await client.connect();
        } catch (error) {
            // Kein harter Fehler: die Bridge kann spaeter zurueckkommen, die
            // Abfrage laeuft weiter und faengt sich dann von selbst.
            this.#status.hue.error = messageOf(error);
            logger.warn(`Hue-Bridge (${bridgeIp}) nicht erreichbar: ${this.#status.hue.error}`);
        }
        this.#hue = client;
        this.#status.hue.bridgeName = client.name;
        this.#status.hue.apiVersion = client.apiVersion;
    }

    // ------------------------------------------------------------------
    // Abfragen
    // ------------------------------------------------------------------
    async #pollHue(): Promise<void> {
        const client = this.#hue;
        const catalog = this.#lampCatalog;
        if (client === undefined || catalog === undefined || this.#hueBusy || this.#stopped) return;
        this.#hueBusy = true;

        try {
            let lights: HueLight[];
            try {
                lights = await client.poll();
            } catch (error) {
                this.#status.hue.connected = false;
                this.#status.hue.error = messageOf(error);
                // Keine Werte heisst: nicht erreichbar. Der letzte Stand bleibt
                // stehen, statt stillschweigend als aktuell zu gelten.
                await this.#markUnreachable([...this.#hueMeters.keys(), HUE_BRIDGE_METER_ID]);
                return;
            }

            this.#status.hue.connected = true;
            this.#status.hue.error = undefined;
            this.#status.hue.bridgeName = client.name;
            this.#status.hue.apiVersion = client.apiVersion;
            this.#status.hue.lights = lights.length;
            this.#status.hue.lastUpdate = new Date().toISOString();

            const { gamma, bridgeWatts } = this.#config.sources.hue;
            const { totals, reports } = aggregateLamps(lights, catalog, gamma, room =>
                this.#idForRoom("hue", room, this.#hueMeters),
            );

            this.#status.hue.rooms = totals.size;
            await this.#applyTotals("hue", totals, this.#hueMeters, HUE_NOMINAL_VOLTAGE);
            // Erst nach dem Anlegen steht endgueltig fest, welche ID ein neuer
            // Raum bekommen hat - zwei Raumnamen koennen auf dieselbe ID fuehren.
            this.#resolveReportIds("hue", reports, this.#hueMeters);

            // Die Bridge selbst laeuft rund um die Uhr mit - ein eigener Zaehler,
            // damit die Raumwerte reines Licht bleiben.
            if (bridgeWatts > 0) {
                const meter = await this.#ensureMeter(
                    HUE_BRIDGE_METER_ID,
                    `${client.name} Grundlast`,
                    "hue-bridge",
                    "",
                    HUE_NOMINAL_VOLTAGE,
                );
                await meter.setReachable(true);
                await meter.applyReading({ power: round(bridgeWatts, 3) });
            }

            this.#replaceReports("hue", reports);
        } catch (error) {
            logger.error("Fehler beim Abfragen der Hue-Bridge:", error);
        } finally {
            this.#hueBusy = false;
        }
    }

    async #pollSonos(): Promise<void> {
        const system = this.#sonos;
        const catalog = this.#speakerCatalog;
        if (system === undefined || catalog === undefined || this.#sonosBusy || this.#stopped) return;
        this.#sonosBusy = true;

        try {
            const speakers = await system.poll();
            const { usbAdapterWatts, mainsVoltage } = this.#config.sources.sonos;

            const { totals, reports } = aggregateSpeakers(speakers, catalog, usbAdapterWatts, room =>
                this.#idForRoom("sonos", room, this.#sonosMeters),
            );

            this.#status.sonos.speakers = speakers.length;
            this.#status.sonos.rooms = totals.size;
            this.#status.sonos.groups = system.groupCount;
            this.#status.sonos.error = system.error;
            if (speakers.length > 0) this.#status.sonos.lastUpdate = new Date().toISOString();

            await this.#applyTotals("sonos", totals, this.#sonosMeters, Number(mainsVoltage));
            this.#resolveReportIds("sonos", reports, this.#sonosMeters);
            this.#replaceReports("sonos", reports);
        } catch (error) {
            logger.error("Fehler beim Abfragen der Sonos-Geraete:", error);
        } finally {
            this.#sonosBusy = false;
        }
    }

    // ------------------------------------------------------------------
    // Zaehler fuehren
    // ------------------------------------------------------------------

    /** ID fuer einen Raum bestimmen - bekannte Raeume behalten ihre ID. */
    #idForRoom(prefix: string, room: string, known: Map<string, string>): string {
        for (const [id, knownRoom] of known) {
            if (knownRoom === room) return id;
        }
        return meterIdFor(prefix, room, new Set(known.keys()));
    }

    async #applyTotals(
        origin: MeterOrigin,
        totals: Map<string, RoomTotal>,
        known: Map<string, string>,
        voltage: number,
    ): Promise<void> {
        const prefix = origin === "sonos" ? "sonos" : "hue";
        const label = origin === "sonos" ? "Sonos" : "Hue";
        const seen = new Set<string>();

        for (const [room, total] of totals) {
            const id = this.#idForRoom(prefix, room, known);
            seen.add(id);
            if (this.#broken.has(id)) continue;

            try {
                const meter = await this.#ensureMeter(id, `${label} ${room}`, origin, room, voltage);
                await meter.setReachable(total.reachable);
                await meter.applyReading({ power: round(total.watts, 2) });
            } catch (error) {
                // Ein Raum, der sich nicht anlegen laesst, darf die uebrigen nicht
                // mitreissen - und nicht bei jeder Abfrage erneut scheitern.
                this.#broken.add(id);
                logger.error(`Zaehler "${id}" (${room}) laesst sich nicht anlegen, wird uebersprungen:`, error);
            }
        }

        // Raum ohne Geraete: der Zaehler bleibt, faellt aber auf 0 - sonst
        // stuende dort fuer immer der letzte Wert.
        for (const id of known.keys()) {
            if (seen.has(id)) continue;
            const meter = this.#bridge.meters.get(id);
            if (meter === undefined) continue;
            await meter.setReachable(true);
            await meter.applyReading({ power: 0 });
        }
    }

    async #ensureMeter(
        id: string,
        name: string,
        origin: MeterOrigin,
        room: string,
        voltage: number,
    ): Promise<VirtualMeter> {
        let meter = this.#bridge.meters.get(id);
        if (meter === undefined) {
            logger.notice(`Neuer Zaehler "${name}" (${id}) aus Quelle ${origin}.`);
            meter = await this.#bridge.addMeter(meterConfigFor(id, name, voltage));
        }
        if (origin === "hue") this.#hueMeters.set(id, room);
        if (origin === "sonos") this.#sonosMeters.set(id, room);
        await this.#registry.remember({ id, name, origin, room });
        return meter;
    }

    async #markUnreachable(ids: Iterable<string>): Promise<void> {
        for (const id of ids) {
            await this.#bridge.meters.get(id)?.setReachable(false);
        }
    }

    #resolveReportIds(prefix: "hue" | "sonos", reports: DeviceReport[], known: Map<string, string>): void {
        for (const report of reports) {
            report.meterId = this.#idForRoom(prefix, report.room, known);
        }
    }

    #replaceReports(source: "hue" | "sonos", reports: DeviceReport[]): void {
        this.#devices = [...this.#devices.filter(entry => entry.source !== source), ...reports].sort(
            (a, b) => b.watts - a.watts,
        );
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Legt den Manager an, sofern ueberhaupt eine Quelle aktiviert ist. */
export function createSourceManager(config: AppConfig, bridge: Bridge): SourceManager | undefined {
    const { hue, sonos } = config.sources;
    if (!hue.enabled && !sonos.enabled) return undefined;
    return new SourceManager(config, bridge);
}
