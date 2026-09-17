/**
 * Von einzelnen Geraeten zu Raumsummen.
 *
 * Bewusst ohne Matter und ohne Netzwerk: hier wird nur gerechnet und gruppiert,
 * damit sich genau dieser Schritt - der neue Teil gegenueber dem Original -
 * eigenstaendig pruefen laesst.
 */
import type { LampCatalog, SpeakerCatalog } from "./catalog.js";
import type { HueLight } from "./hue.js";
import { estimateLamp, estimateSpeaker } from "./model.js";
import type { SonosSpeaker } from "./sonos.js";

/** Lampen ohne Raumzuordnung landen gesammelt hier. */
export const UNASSIGNED_ROOM = "Ohne Raum";

/** Zustaende, die Sonos ueber AVTransport meldet. */
const TRANSPORT_LABELS: Record<string, string> = {
    PLAYING: "spielt",
    PAUSED_PLAYBACK: "pausiert",
    STOPPED: "gestoppt",
    TRANSITIONING: "laedt",
};

/** Ein einzelnes Geraet, wie es die HTTP-API zur Kontrolle ausgibt. */
export interface DeviceReport {
    source: "hue" | "sonos";
    id: string;
    name: string;
    room: string;
    /** Zaehler, in den dieses Geraet einfliesst. */
    meterId: string;
    watts: number;
    standbyW: number;
    /** brennt bzw. spielt gerade */
    active: boolean;
    reachable: boolean;
    /** Helligkeit oder Lautstaerke, 0..1 */
    level: number;
    state: string;
    /** Klartextname des Modelleintrags. */
    model: string;
    /** Wie der Eintrag gefunden wurde: exact | family | archetype | default | override */
    match: string;
    /** Leistungsdaten sind geraten. */
    estimate: boolean;
    /** Nur bei Lautsprechern: wired | usb | wireless */
    link?: string;
}

export interface RoomTotal {
    watts: number;
    /** Mindestens ein Geraet des Raums antwortet. */
    reachable: boolean;
}

export interface Aggregation {
    totals: Map<string, RoomTotal>;
    reports: DeviceReport[];
}

/** Liefert die Zaehler-ID zu einem Raum - die Zuordnung kennt nur der Aufrufer. */
export type MeterIdResolver = (room: string) => string;

function addTo(totals: Map<string, RoomTotal>, room: string, watts: number, reachable: boolean): void {
    const total = totals.get(room) ?? { watts: 0, reachable: false };
    total.watts += watts;
    total.reachable = total.reachable || reachable;
    totals.set(room, total);
}

/** Lampen je Raum zusammenfassen. */
export function aggregateLamps(
    lights: readonly HueLight[],
    catalog: LampCatalog,
    gamma: number,
    meterIdFor: MeterIdResolver,
): Aggregation {
    const totals = new Map<string, RoomTotal>();
    const reports: DeviceReport[] = [];

    for (const light of lights) {
        const spec = catalog.lookup({
            id: light.id,
            name: light.name,
            modelId: light.modelId,
            archetype: light.archetype,
            capability: light.capability,
        });
        const estimate = estimateLamp(light, spec, gamma);
        const room = light.room || UNASSIGNED_ROOM;

        addTo(totals, room, estimate.watts, light.reachable);
        reports.push({
            source: "hue",
            id: light.id,
            name: light.name,
            room,
            meterId: meterIdFor(room),
            watts: round(estimate.watts, 2),
            standbyW: round(estimate.standbyW, 2),
            active: light.on && light.reachable,
            reachable: light.reachable,
            level: round(light.brightness, 3),
            state: !light.reachable ? "stromlos" : light.on ? "an" : "aus",
            model: spec.label,
            match: spec.match,
            estimate: estimate.uncertain,
        });
    }

    return { totals, reports };
}

/** Lautsprecher je Zone zusammenfassen. */
export function aggregateSpeakers(
    speakers: readonly SonosSpeaker[],
    catalog: SpeakerCatalog,
    usbAdapterWatts: number,
    meterIdFor: MeterIdResolver,
): Aggregation {
    const totals = new Map<string, RoomTotal>();
    const reports: DeviceReport[] = [];

    for (const speaker of speakers) {
        const spec = catalog.lookup({ name: speaker.name, model: speaker.model });
        // Ein Era haengt am Kabel, hat aber keinen Netzwerkanschluss: dann laeuft
        // das ueber den USB-Adapter, der mitzaehlt.
        const usbAdapter = speaker.wired && catalog.needsUsbEthernet(speaker.model);
        const estimate = estimateSpeaker(speaker, spec, usbAdapter ? usbAdapterWatts : 0);
        const room = zoneOf(speaker);

        addTo(totals, room, estimate.watts, speaker.reachable);
        reports.push({
            source: "sonos",
            id: speaker.id,
            name: speakerLabel(speaker, speakers),
            room,
            meterId: meterIdFor(room),
            watts: round(estimate.watts, 2),
            standbyW: round(estimate.standbyW, 2),
            active: speaker.playing && speaker.reachable && !speaker.muted,
            reachable: speaker.reachable,
            level: round(speaker.volume, 3),
            state: speakerState(speaker),
            model: spec.label,
            match: spec.match,
            estimate: estimate.uncertain,
            link: usbAdapter ? "usb" : speaker.wired ? "wired" : "wireless",
        });
    }

    return { totals, reports };
}

function zoneOf(speaker: SonosSpeaker): string {
    return speaker.room || speaker.name;
}

/**
 * Sonos benennt nicht das einzelne Geraet, sondern die Zone. Ein Stereopaar oder
 * ein Heimkino meldet deshalb mehrfach denselben Namen - fuer die Geraeteliste
 * wird das Modell ergaenzt, bei gleichen Modellen zusaetzlich durchnummeriert.
 */
export function speakerLabel(speaker: SonosSpeaker, all: readonly SonosSpeaker[]): string {
    const zone = zoneOf(speaker);
    const group = all.filter(entry => zoneOf(entry) === zone);
    if (group.length <= 1) return zone;

    const model = shortModel(speaker.model);
    // Nach ID sortieren, damit die Nummerierung ueber Neustarts gleich bleibt.
    const sameModel = group
        .filter(entry => shortModel(entry.model) === model)
        .sort((a, b) => a.id.localeCompare(b.id));
    if (sameModel.length <= 1) return `${zone} · ${model}`;

    return `${zone} · ${model} ${sameModel.findIndex(entry => entry.id === speaker.id) + 1}`;
}

/** "Sonos Beam (Gen 2)" -> "Beam (Gen 2)" */
export function shortModel(model: string): string {
    let text = (model ?? "").trim();
    for (const prefix of ["Sonos ", "IKEA "]) {
        if (text.startsWith(prefix)) text = text.slice(prefix.length);
    }
    return text || "Box";
}

export function speakerState(speaker: SonosSpeaker): string {
    if (!speaker.reachable) return "nicht erreichbar";
    if (speaker.muted) return "stumm";
    if (!speaker.playing) return TRANSPORT_LABELS[speaker.transport] ?? "bereit";
    return "spielt";
}

export function round(value: number, digits: number): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
