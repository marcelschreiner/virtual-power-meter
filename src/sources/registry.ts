/**
 * Merkt sich, welche Zaehler die Quellen bereits angelegt haben.
 *
 * Ohne diese Liste entstuenden die Endpoints erst, wenn Hue oder Sonos beim
 * Start tatsaechlich antworten. Ist die Bridge gerade weg, verschwaenden die
 * Geraete im Controller - mit der Liste bleiben sie bestehen und melden sich
 * lediglich als nicht erreichbar.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type MeterOrigin = "hue" | "sonos" | "hue-bridge";

export interface KnownMeter {
    id: string;
    name: string;
    origin: MeterOrigin;
    /** Raumname, aus dem die ID entstanden ist. */
    room: string;
}

interface RegistryFile {
    version: 1;
    meters: KnownMeter[];
}

export class KnownMeterStore {
    readonly #path: string;
    #state: RegistryFile = { version: 1, meters: [] };

    constructor(storagePath: string) {
        this.#path = join(storagePath, "source-meters.json");
    }

    get path(): string {
        return this.#path;
    }

    async load(): Promise<void> {
        try {
            const parsed = JSON.parse(await readFile(this.#path, "utf8")) as RegistryFile;
            if (parsed?.version === 1 && Array.isArray(parsed.meters)) {
                this.#state = { version: 1, meters: parsed.meters.filter(entry => typeof entry?.id === "string") };
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                // Eine kaputte Liste darf den Start nicht verhindern - die Zaehler
                // entstehen dann eben bei der ersten erfolgreichen Abfrage neu.
                console.warn(`Zaehlerliste in ${this.#path} unlesbar, starte mit leerer Liste:`, error);
            }
        }
    }

    list(): KnownMeter[] {
        return [...this.#state.meters];
    }

    /** Legt einen neuen Eintrag an oder zieht einen geaenderten Namen nach. */
    async remember(meter: KnownMeter): Promise<void> {
        const existing = this.#state.meters.find(entry => entry.id === meter.id);
        if (existing !== undefined) {
            if (existing.name === meter.name && existing.room === meter.room) return;
            existing.name = meter.name;
            existing.room = meter.room;
        } else {
            this.#state.meters.push(meter);
        }
        await this.#write();
    }

    async #write(): Promise<void> {
        await mkdir(dirname(this.#path), { recursive: true });
        const tmp = `${this.#path}.tmp`;
        await writeFile(tmp, JSON.stringify(this.#state, null, 2), "utf8");
        await rename(tmp, this.#path);
    }
}
