/**
 * Zuordnung von Geraeten zu Leistungsdaten.
 *
 * Die eigentlichen Zahlen stehen in `data/lamp-models.json` und
 * `data/speaker-models.json`. Dieses Modul kuemmert sich nur darum, fuer ein
 * konkretes Geraet den bestmoeglichen Eintrag zu finden und dabei ehrlich zu
 * markieren, wie gut der Treffer war.
 */
import { readFile } from "node:fs/promises";
import type { DeviceSpec } from "./model.js";

// Wie gut passt der gefundene Eintrag?
export const MATCH_EXACT = "exact"; // Modell-ID steht so in der Datenbank
export const MATCH_FAMILY = "family"; // gleiche Modellfamilie (z. B. LCT0xx)
export const MATCH_ARCHETYPE = "archetype"; // ueber die Bauform der Leuchte geraten
export const MATCH_DEFAULT = "default"; // nur ueber die Faehigkeiten geraten
export const MATCH_OVERRIDE = "override"; // vom Benutzer selbst gesetzt

/** Ab hier ist der Wert eine Schaetzung und wird in der Ausgabe markiert. */
const UNCERTAIN = new Set([MATCH_FAMILY, MATCH_ARCHETYPE, MATCH_DEFAULT]);

/** Werte, die ein Benutzer pro Modell oder pro Geraet ueberschreiben darf. */
export interface SpecOverride {
    max_w?: number;
    standby_w?: number;
    gamma?: number;
    kind?: string;
    label?: string;
}

interface CatalogEntry {
    max_w: number;
    standby_w?: number;
    idle_w?: number | Record<string, number>;
    gamma?: number;
    kind?: string;
    label?: string;
    source?: string;
    no_ethernet?: boolean;
}

interface LampData {
    defaults: Record<string, CatalogEntry>;
    archetypes?: Record<string, CatalogEntry>;
    models: Record<string, CatalogEntry>;
}

interface SpeakerData {
    defaults: Record<string, CatalogEntry>;
    models: Record<string, CatalogEntry>;
    aliases?: Record<string, string>;
}

export interface LampOverrides {
    by_model?: Record<string, SpecOverride>;
    by_light?: Record<string, SpecOverride>;
}

export interface SpeakerOverrides {
    by_model?: Record<string, SpecOverride>;
    by_name?: Record<string, SpecOverride>;
}

/** Merkmale einer Lampe, soweit der Katalog sie zur Zuordnung braucht. */
export interface LampIdentity {
    id: string;
    name: string;
    modelId: string;
    archetype: string;
    /** color | ct | dimmable | onoff */
    capability: string;
}

/** Merkmale eines Lautsprechers, soweit der Katalog sie braucht. */
export interface SpeakerIdentity {
    name: string;
    model: string;
}

const LAMP_FILE = new URL("./data/lamp-models.json", import.meta.url);
const SPEAKER_FILE = new URL("./data/speaker-models.json", import.meta.url);

async function readJson<T>(url: URL): Promise<T> {
    return JSON.parse(await readFile(url, "utf8")) as T;
}

function makeSpec(entry: CatalogEntry, match: string, standbyW: number): DeviceSpec {
    const source = entry.source ?? "estimated";
    return {
        maxW: Number(entry.max_w),
        standbyW,
        gamma: Number(entry.gamma ?? 2),
        kind: entry.kind ?? "color",
        label: entry.label ?? "unbekannt",
        source,
        match,
        isEstimate: UNCERTAIN.has(match) || source === "estimated",
    };
}

/** Benutzerwerte haben immer Vorrang - sie gelten als exakt, nicht als Schaetzung. */
function applyOverride(spec: DeviceSpec, patch: SpecOverride | undefined): DeviceSpec {
    if (patch === undefined) return spec;
    return {
        ...spec,
        maxW: patch.max_w ?? spec.maxW,
        standbyW: patch.standby_w ?? spec.standbyW,
        gamma: patch.gamma ?? spec.gamma,
        kind: patch.kind ?? spec.kind,
        label: patch.label ?? spec.label,
        source: "override",
        match: MATCH_OVERRIDE,
        isEstimate: false,
    };
}

function lowerKeys(table: Record<string, SpecOverride> | undefined): Map<string, SpecOverride> {
    return new Map(Object.entries(table ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
}

export class LampCatalog {
    readonly #defaults: Record<string, CatalogEntry>;
    readonly #archetypes: Record<string, CatalogEntry>;
    readonly #models: Record<string, CatalogEntry>;
    readonly #byModel: Record<string, SpecOverride>;
    readonly #byLight: Map<string, SpecOverride>;

    constructor(data: LampData, overrides: LampOverrides = {}) {
        this.#defaults = data.defaults;
        this.#archetypes = data.archetypes ?? {};
        this.#models = data.models;
        this.#byModel = overrides.by_model ?? {};
        this.#byLight = lowerKeys(overrides.by_light);
    }

    static async load(overrides: LampOverrides = {}): Promise<LampCatalog> {
        return new LampCatalog(await readJson<LampData>(LAMP_FILE), overrides);
    }

    /** Beste verfuegbare Leistungsdaten fuer eine Lampe. */
    lookup(light: LampIdentity): DeviceSpec {
        let spec = this.#baseSpec(light);

        // Erst pro Modell, dann pro Lampe (ID oder Name) - spaeter gewinnt.
        spec = applyOverride(spec, light.modelId ? this.#byModel[light.modelId] : undefined);
        spec = applyOverride(spec, this.#byLight.get(light.id.toLowerCase()));
        spec = applyOverride(spec, this.#byLight.get(light.name.toLowerCase()));
        return spec;
    }

    #baseSpec(light: LampIdentity): DeviceSpec {
        const model = (light.modelId ?? "").trim();

        const entry = this.#models[model];
        if (entry !== undefined) return makeSpec(entry, MATCH_EXACT, Number(entry.standby_w ?? 0));

        // Unbekannte Modell-ID: Nachbarn aus derselben Familie mitteln.
        // "LCA042" -> Praefix "LCA", damit neue Varianten nicht ins Leere laufen.
        const family = /^([A-Z]{3})\d/.exec(model);
        if (family !== null) {
            const prefix = family[1] as string;
            const siblings = Object.entries(this.#models)
                .filter(([key]) => key.startsWith(prefix))
                .map(([, value]) => value);
            if (siblings.length > 0) {
                const averaged: CatalogEntry = {
                    max_w: average(siblings.map(s => Number(s.max_w))),
                    standby_w: average(siblings.map(s => Number(s.standby_w ?? 0))),
                    kind: majority(siblings.map(s => s.kind ?? "color")),
                    label: `${model} (aus ${prefix}* abgeleitet)`,
                    source: "estimated",
                };
                return makeSpec(averaged, MATCH_FAMILY, Number(averaged.standby_w));
            }
        }

        const arch = this.#archetypes[light.archetype ?? ""];
        if (arch !== undefined) return makeSpec(arch, MATCH_ARCHETYPE, Number(arch.standby_w ?? 0));

        const fallback = this.#defaults[defaultKind(light)] ?? this.#defaults["color"];
        if (fallback === undefined) {
            throw new Error("lamp-models.json enthaelt keine brauchbaren Defaults");
        }
        return makeSpec(fallback, MATCH_DEFAULT, Number(fallback.standby_w ?? 0));
    }
}

function defaultKind(light: LampIdentity): string {
    if (light.archetype === "plug") return "plug";
    if (light.capability === "onoff") return "onoff";
    if (light.capability === "color" || light.capability === "ct") return light.capability;
    return "dimmable";
}

/**
 * Dasselbe fuer Sonos-Geraete. Zugeordnet wird ueber den Modellnamen, den der
 * Player selbst meldet (z. B. "Sonos Era 100").
 */
export class SpeakerCatalog {
    readonly #defaults: Record<string, CatalogEntry>;
    readonly #models: Record<string, CatalogEntry>;
    readonly #aliases: Record<string, string>;
    readonly #voltage: "230" | "120";
    readonly #byModel: Map<string, SpecOverride>;
    readonly #byName: Map<string, SpecOverride>;

    constructor(data: SpeakerData, overrides: SpeakerOverrides = {}, voltage = "230") {
        this.#defaults = data.defaults;
        this.#models = data.models;
        this.#aliases = data.aliases ?? {};
        this.#voltage = voltage === "120" ? "120" : "230";
        this.#byModel = lowerKeys(overrides.by_model);
        this.#byName = lowerKeys(overrides.by_name);
    }

    static async load(overrides: SpeakerOverrides = {}, voltage = "230"): Promise<SpeakerCatalog> {
        return new SpeakerCatalog(await readJson<SpeakerData>(SPEAKER_FILE), overrides, voltage);
    }

    /**
     * True, wenn das Modell gar keinen eigenen Netzwerkanschluss hat - ein Kabel
     * kann dann nur ueber den USB-Adapter kommen.
     */
    needsUsbEthernet(model: string): boolean {
        const key = normaliseModel(model);
        const resolved = this.#aliases[key] ?? key;
        return this.#models[resolved]?.no_ethernet === true;
    }

    lookup(speaker: SpeakerIdentity): DeviceSpec {
        const key = normaliseModel(speaker.model);
        let spec = this.#baseSpec(key);

        spec = applyOverride(spec, this.#byModel.get(key));
        spec = applyOverride(spec, this.#byName.get(speaker.name.toLowerCase()));
        return spec;
    }

    #baseSpec(rawKey: string): DeviceSpec {
        const key = this.#aliases[rawKey] ?? rawKey;
        const entry = this.#models[key];
        if (entry !== undefined) return this.#make(entry, MATCH_EXACT);

        // "Sonos One (Gen 1)" faellt sonst durch - Klammerzusatz weglassen und
        // danach Wort fuer Wort kuerzen, bis etwas passt.
        const parts = key.split(" ");
        while (parts.length > 1) {
            parts.pop();
            const candidate = parts.join(" ");
            const resolved = this.#aliases[candidate] ?? candidate;
            const shorter = this.#models[resolved];
            if (shorter !== undefined) return this.#make(shorter, MATCH_FAMILY);
        }

        const fallback = this.#defaults["speaker"];
        if (fallback === undefined) {
            throw new Error("speaker-models.json enthaelt keinen Default fuer Lautsprecher");
        }
        return this.#make(fallback, MATCH_DEFAULT);
    }

    #make(entry: CatalogEntry, match: string): DeviceSpec {
        // Die Leerlaufwerte von Sonos haengen an der Netzspannung.
        const idle = entry.idle_w ?? entry.standby_w ?? 0;
        const idleW = typeof idle === "object" ? Number(idle[this.#voltage] ?? 0) : Number(idle);
        return { ...makeSpec(entry, match, idleW), kind: entry.kind ?? "speaker", label: entry.label ?? "Lautsprecher" };
    }
}

/** "Sonos Era 100" -> "era 100". */
export function normaliseModel(model: string): string {
    let text = (model ?? "").trim().toLowerCase();
    for (const prefix of ["sonos ", "ikea "]) {
        if (text.startsWith(prefix)) text = text.slice(prefix.length);
    }
    return text.split(/\s+/).filter(Boolean).join(" ");
}

function average(values: number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function majority(values: string[]): string {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    let best = values[0] ?? "color";
    let bestCount = 0;
    for (const [value, count] of counts) {
        if (count > bestCount) {
            best = value;
            bestCount = count;
        }
    }
    return best;
}
