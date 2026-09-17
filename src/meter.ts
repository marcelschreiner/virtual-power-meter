/**
 * Fachlogik eines virtuellen Zaehlers: Messwerte entgegennehmen, Energie
 * aufintegrieren und den Zustand in die Matter-Attribute schreiben.
 *
 * Einheiten: nach aussen (Konfiguration, HTTP-API) W / V / A / kWh,
 * intern und Richtung Matter mW / mV / mA / mWh.
 */
import type { Endpoint } from "@matter/main";
import type { MeterConfig } from "./config.js";
import type { EnergyStore } from "./persistence.js";
import type { VirtualMeterEndpoint } from "./matter/endpoints.js";

/**
 * Beide Endpoint-Varianten tragen dieselben Messcluster; fuer das Schreiben der
 * Messwerte reicht daher der Typ der Sensor-Variante.
 */
export type MeasurementEndpoint = Endpoint<typeof VirtualMeterEndpoint>;

const MWH_PER_KWH = 1_000_000;

export interface MeterReading {
    /** Wirkleistung in Watt. Positiv = Bezug, negativ = Einspeisung. */
    power?: number;
    /** Spannung in Volt. Ohne Angabe wird die Nennspannung benutzt. */
    voltage?: number;
    /** Strom in Ampere. Ohne Angabe aus Leistung und Spannung berechnet. */
    current?: number;
    /** Absoluter Zaehlerstand Bezug in kWh. Schaltet den Zaehler auf externe Staende um. */
    energyImported?: number;
    /** Absoluter Zaehlerstand Einspeisung in kWh. */
    energyExported?: number;
}

export interface MeterSnapshot {
    id: string;
    name: string;
    kind: MeterConfig["kind"];
    power: number;
    voltage: number;
    current: number;
    energyImported: number;
    energyExported: number;
    energyMode: EnergyMode;
    updatedAt: string | null;
    /** Meldet die Quelle das Geraet gerade als erreichbar? */
    reachable: boolean;
}

/**
 * "integrate": Energie wird aus der gemeldeten Leistung aufintegriert.
 * "external":  Energie kommt als absoluter Zaehlerstand von aussen, dann wird
 *              nicht mehr integriert, damit sich beides nicht addiert.
 */
export type EnergyMode = "integrate" | "external";

export class VirtualMeter {
    readonly config: MeterConfig;
    readonly #store: EnergyStore;
    #endpoint?: MeasurementEndpoint;

    #powerW = 0;
    #voltageV: number;
    #currentA = 0;
    #energyImportedMwh: number;
    #energyExportedMwh: number;
    #energyMode: EnergyMode = "integrate";
    #reachable = true;
    #lastIntegrationMs = Date.now();
    #updatedAt: Date | null = null;
    #simulationTimer?: NodeJS.Timeout;

    constructor(config: MeterConfig, store: EnergyStore) {
        this.config = config;
        this.#store = store;
        this.#voltageV = config.nominalVoltage;

        const persisted = store.get(config.id);
        this.#energyImportedMwh = persisted?.importedMwh ?? config.initialEnergyImportedKwh * MWH_PER_KWH;
        this.#energyExportedMwh = persisted?.exportedMwh ?? config.initialEnergyExportedKwh * MWH_PER_KWH;
    }

    get id(): string {
        return this.config.id;
    }

    /**
     * Verbindet den Zaehler mit seinem Matter-Endpoint. Der Endpoint entsteht
     * erst nach dem Zaehler, weil er dessen persistierte Staende als
     * Initialwerte braucht.
     */
    attach(endpoint: MeasurementEndpoint): this {
        this.#endpoint = endpoint;
        return this;
    }

    get snapshot(): MeterSnapshot {
        return {
            id: this.config.id,
            name: this.config.name,
            kind: this.config.kind,
            power: round(this.#powerW, 3),
            voltage: round(this.#voltageV, 3),
            current: round(this.#currentA, 4),
            energyImported: round(this.#energyImportedMwh / MWH_PER_KWH, 6),
            energyExported: round(this.#energyExportedMwh / MWH_PER_KWH, 6),
            energyMode: this.#energyMode,
            updatedAt: this.#updatedAt?.toISOString() ?? null,
            reachable: this.#reachable,
        };
    }

    /** Initialer Zustand fuer die Matter-Cluster beim Anlegen des Endpoints. */
    get initialMeasurementState() {
        return measurementState(
            this.#powerW,
            this.#voltageV,
            this.#currentA,
            this.#energyImportedMwh,
            this.#energyExportedMwh,
        );
    }

    /**
     * Erreichbarkeit des Geraets im Matter-Cluster nachziehen. Faellt die Quelle
     * aus, zeigen Ecosysteme das als "keine Antwort" an, statt stillschweigend
     * den letzten Wert weiterzufuehren.
     */
    async setReachable(reachable: boolean): Promise<void> {
        if (this.#reachable === reachable) return;
        this.#reachable = reachable;
        await this.#endpoint?.set({ bridgedDeviceBasicInformation: { reachable } });
    }

    async applyReading(reading: MeterReading): Promise<void> {
        const now = Date.now();
        // Erst mit dem alten Leistungswert bis jetzt integrieren, dann uebernehmen.
        this.#integrateUntil(now);

        if (reading.energyImported !== undefined || reading.energyExported !== undefined) {
            this.#energyMode = "external";
            if (reading.energyImported !== undefined) {
                this.#energyImportedMwh = reading.energyImported * MWH_PER_KWH;
            }
            if (reading.energyExported !== undefined) {
                this.#energyExportedMwh = reading.energyExported * MWH_PER_KWH;
            }
        }

        if (reading.voltage !== undefined) this.#voltageV = reading.voltage;
        if (reading.power !== undefined) this.#powerW = reading.power;
        this.#currentA = reading.current ?? this.#deriveCurrent();

        this.#updatedAt = new Date(now);
        this.#store.set(this.config.id, this.#energyImportedMwh, this.#energyExportedMwh);
        await this.#push();
    }

    /** Periodischer Tick: Energie fortschreiben, auch wenn keine neuen Werte kommen. */
    async tick(): Promise<void> {
        const changed = this.#integrateUntil(Date.now());
        if (!changed) return;
        this.#store.set(this.config.id, this.#energyImportedMwh, this.#energyExportedMwh);
        await this.#push();
    }

    startSimulation(): void {
        const { simulation } = this.config;
        if (!simulation.enabled || this.#simulationTimer !== undefined) return;

        const step = () => {
            const span = simulation.maxWatts - simulation.minWatts;
            // Random Walk innerhalb der konfigurierten Grenzen - sieht realistischer
            // aus als ein reiner Zufallswert und erzeugt brauchbare Verlaufskurven.
            const drift = (Math.random() - 0.5) * span * 0.3;
            const next = clamp(this.#powerW + drift, simulation.minWatts, simulation.maxWatts);
            void this.applyReading({ power: next }).catch(error =>
                console.error(`Simulation fuer "${this.config.id}" fehlgeschlagen:`, error),
            );
        };

        // Startwert in die Mitte des Bandes legen, damit der Walk nicht bei 0 klebt.
        this.#powerW = clamp(
            (simulation.minWatts + simulation.maxWatts) / 2,
            simulation.minWatts,
            simulation.maxWatts,
        );
        this.#simulationTimer = setInterval(step, simulation.intervalSeconds * 1000);
        this.#simulationTimer.unref?.();
        step();
    }

    stopSimulation(): void {
        if (this.#simulationTimer !== undefined) {
            clearInterval(this.#simulationTimer);
            this.#simulationTimer = undefined;
        }
    }

    #deriveCurrent(): number {
        if (this.#voltageV <= 0) return 0;
        return Math.abs(this.#powerW) / (this.#voltageV * this.config.phases);
    }

    /** Integriert die aktuelle Leistung bis `now` auf. Gibt zurueck, ob sich etwas geaendert hat. */
    #integrateUntil(now: number): boolean {
        const elapsedMs = now - this.#lastIntegrationMs;
        this.#lastIntegrationMs = now;
        if (this.#energyMode === "external" || elapsedMs <= 0 || this.#powerW === 0) return false;

        // mWh = W * ms / 3600
        const deltaMwh = (Math.abs(this.#powerW) * elapsedMs) / 3600;
        if (this.#powerW > 0) {
            this.#energyImportedMwh += deltaMwh;
        } else {
            this.#energyExportedMwh += deltaMwh;
        }
        return true;
    }

    async #push(): Promise<void> {
        if (this.#endpoint === undefined) return;
        await this.#endpoint.set(
            measurementState(
                this.#powerW,
                this.#voltageV,
                this.#currentA,
                this.#energyImportedMwh,
                this.#energyExportedMwh,
            ),
        );
    }
}

function measurementState(
    powerW: number,
    voltageV: number,
    currentA: number,
    importedMwh: number,
    exportedMwh: number,
) {
    // matter.js erwartet epoch-s als Unix-Zeit und rechnet selbst auf die
    // Matter-Epoche (2000-01-01) um.
    const nowEpochS = Math.floor(Date.now() / 1000);
    return {
        electricalPowerMeasurement: {
            activePower: Math.round(powerW * 1000),
            voltage: Math.round(voltageV * 1000),
            activeCurrent: Math.round(currentA * 1000),
        },
        electricalEnergyMeasurement: {
            cumulativeEnergyImported: {
                energy: Math.round(importedMwh),
                endTimestamp: nowEpochS,
            },
            cumulativeEnergyExported: {
                energy: Math.round(exportedMwh),
                endTimestamp: nowEpochS,
            },
        },
    };
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function round(value: number, digits: number): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
