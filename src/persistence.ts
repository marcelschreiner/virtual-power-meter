/**
 * Persistenz der Zaehlerstaende.
 *
 * Matter persistiert die Messattribute nicht, ein Container-Neustart wuerde die
 * Zaehler also auf 0 zuruecksetzen. Deshalb schreiben wir die kumulierten Werte
 * selbst in eine kleine JSON-Datei neben den Matter-Daten.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface MeterEnergyState {
    /** Bezug (Import) in Milliwattstunden. */
    importedMwh: number;
    /** Einspeisung (Export) in Milliwattstunden. */
    exportedMwh: number;
    /** Zeitpunkt des letzten Schreibvorgangs, nur zur Diagnose. */
    updatedAt: string;
}

export interface EnergyStateFile {
    version: 1;
    meters: Record<string, MeterEnergyState>;
}

export class EnergyStore {
    readonly #path: string;
    #state: EnergyStateFile = { version: 1, meters: {} };
    #dirty = false;
    #writing: Promise<void> = Promise.resolve();

    constructor(storagePath: string) {
        this.#path = join(storagePath, "energy-state.json");
    }

    get path(): string {
        return this.#path;
    }

    async load(): Promise<void> {
        try {
            const parsed = JSON.parse(await readFile(this.#path, "utf8")) as EnergyStateFile;
            if (parsed?.version === 1 && typeof parsed.meters === "object" && parsed.meters !== null) {
                this.#state = parsed;
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                // Ein kaputter Zaehlerstand darf den Start nicht verhindern - wir fangen bei 0 an.
                console.warn(`Zaehlerstaende in ${this.#path} unlesbar, starte mit Nullwerten:`, error);
            }
        }
    }

    get(id: string): MeterEnergyState | undefined {
        return this.#state.meters[id];
    }

    set(id: string, importedMwh: number, exportedMwh: number): void {
        this.#state.meters[id] = {
            importedMwh,
            exportedMwh,
            updatedAt: new Date().toISOString(),
        };
        this.#dirty = true;
    }

    /** Schreibt nur, wenn sich seit dem letzten Flush etwas geaendert hat. */
    async flush(force = false): Promise<void> {
        if (!this.#dirty && !force) return;
        this.#dirty = false;
        // Schreibvorgaenge serialisieren, damit sich parallele Aufrufe nicht ueberholen.
        // Ein fehlgeschlagener Schreibversuch darf die Kette nicht vergiften -
        // der naechste Flush soll es wieder versuchen duerfen.
        const pending = this.#writing.then(
            () => this.#write(),
            () => this.#write(),
        );
        this.#writing = pending.catch(() => undefined);
        return pending;
    }

    async #write(): Promise<void> {
        await mkdir(dirname(this.#path), { recursive: true });
        const tmp = `${this.#path}.tmp`;
        await writeFile(tmp, JSON.stringify(this.#state, null, 2), "utf8");
        // Atomar ersetzen, damit ein Stromausfall keine halbe Datei hinterlaesst.
        await rename(tmp, this.#path);
    }
}
