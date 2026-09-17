/**
 * Das Schaetzmodell: Geraetezustand -> Watt.
 *
 * Grundgleichung fuer Lampen
 * --------------------------
 *     aus:  P = P_standby
 *     an:   P = P_standby + P_treiber + (P_max - P_standby - P_treiber) * b^gamma * f_farbe
 *
 * `b` ist die Helligkeit als Bruchteil (0..1), `gamma` der Exponent der
 * Helligkeitskurve. Hue rechnet intern von einer wahrnehmungs-linearen Skala auf
 * den LED-Strom um; nachgemessen ergibt sich dabei naeherungsweise ein
 * quadratischer Zusammenhang (gamma = 2.0), nicht der oft vermutete exponentielle.
 *
 * `f_farbe` beruecksichtigt, dass eine gesaettigte Farbe nur einen Teil der
 * LED-Kanaele ansteuert. Entscheidend ist der Abstand zur Planckschen Kurve,
 * nicht das RGB-Verhaeltnis: eine Farblampe erzeugt Weisstoene mit ihren eigenen
 * weissen LEDs und zieht dabei fast die volle Leistung - auch bei warmem Weiss,
 * das in sRGB nur wenig Blauanteil hat. Erst wenn die Farbe die Weisskurve
 * verlaesst, uebernehmen die Farbkanaele und die Aufnahme sinkt.
 */

/** Leistungsanteil der einzelnen Farbkanaele an der Gesamtaufnahme.
 *  Rot braucht fuer denselben Lichtstrom etwas mehr Strom als Gruen/Blau. */
const CHANNEL_WEIGHTS: readonly [number, number, number] = [0.36, 0.33, 0.31];

/** Selbst bei 1 % Helligkeit laeuft das Vorschaltgeraet mit. Dieser Anteil kommt
 *  beim Einschalten sofort dazu, unabhaengig vom Dimmwert. */
const DRIVER_OVERHEAD_W = 0.25;

/** Bis zu diesem xy-Abstand gilt eine Farbe als Weiss, darueber faellt der
 *  Weissanteil linear bis zur vollen Saettigung ab. */
const LOCUS_TOLERANCE = 0.02;
const LOCUS_RANGE = 0.13;

/** Leistungsdaten eines Geraets, aufgeloest aus Katalog und Overrides. */
export interface DeviceSpec {
    /** Aufnahme bei 100 % Helligkeit bzw. voller Aussteuerung. */
    maxW: number;
    /** Aufnahme im ausgeschalteten (Lampe) bzw. Leerlauf-Zustand (Box). */
    standbyW: number;
    /** Exponent der Helligkeits- bzw. Lautstaerkekurve. */
    gamma: number;
    /** color | ct | dimmable | onoff | plug | speaker | line | network */
    kind: string;
    /** Klartextname des Modells. */
    label: string;
    /** measured | nameplate | estimated | override */
    source: string;
    /** exact | family | archetype | default | override */
    match: string;
    /** Modelldaten sind geraten - in der Ausgabe markiert. */
    isEstimate: boolean;
}

export interface Estimate {
    watts: number;
    /** Anteil, der auch im Aus-Zustand fliesst. */
    standbyW: number;
    /** 1.0 = Weiss, kleiner = gesaettigte Farbe. */
    colorFactor: number;
    /** Modelldaten oder Aufschlaege sind geschaetzt. */
    uncertain: boolean;
}

export type Xy = readonly [number, number];

/** Lampenzustand, soweit das Modell ihn braucht. */
export interface LampState {
    reachable: boolean;
    on: boolean;
    /** 0..1 */
    brightness: number;
    mode: "xy" | "ct" | "none";
    xy?: Xy;
    gradientXy?: readonly Xy[];
}

/** Lautsprecherzustand, soweit das Modell ihn braucht. */
export interface SpeakerState {
    reachable: boolean;
    playing: boolean;
    muted: boolean;
    /** 0..1 */
    volume: number;
}

/** Momentane Leistungsaufnahme einer Lampe. */
export function estimateLamp(light: LampState, spec: DeviceSpec, gamma?: number): Estimate {
    const g = gamma ?? spec.gamma;

    if (!light.reachable) {
        // Lampe stromlos (Wandschalter aus) - sie meldet sich nicht mehr.
        return { watts: 0, standbyW: 0, colorFactor: 1, uncertain: spec.isEstimate };
    }
    if (!light.on) {
        return { watts: spec.standbyW, standbyW: spec.standbyW, colorFactor: 1, uncertain: spec.isEstimate };
    }
    if (spec.kind === "plug") {
        // Eine Steckdose weiss nichts ueber ihre Last; maxW ist hier der vom
        // Benutzer konfigurierte Verbrauch des angeschlossenen Geraets.
        return { watts: spec.maxW, standbyW: spec.standbyW, colorFactor: 1, uncertain: spec.isEstimate };
    }

    const fColor = colorFactor(light);
    const b = clamp(light.brightness, 0, 1);

    const headroom = Math.max(0, spec.maxW - spec.standbyW);
    const driver = Math.min(DRIVER_OVERHEAD_W, headroom);
    const watts = spec.standbyW + driver + (headroom - driver) * b ** g * fColor;

    return { watts, standbyW: spec.standbyW, colorFactor: fColor, uncertain: spec.isEstimate };
}

/**
 * Momentane Leistungsaufnahme eines Sonos-Geraets.
 *
 * Das Modell ist bewusst einfacher als bei den Lampen, weil es groeber sein
 * muss: Ein Verstaerker zieht Leistung nach dem, was er gerade wiedergibt. Bei
 * gleicher Lautstaerke verbraucht ein basslastiges Stueck deutlich mehr als ein
 * Hoerbuch. Geschaetzt wird der Mittelwert ueber typisches Musikmaterial.
 *
 * `adapterW` ist der Aufschlag fuer einen USB-Netzwerkadapter. Er haengt am
 * Lautsprecher und zieht rund um die Uhr Strom, taucht in den Herstellerangaben
 * aber nicht auf.
 */
export function estimateSpeaker(speaker: SpeakerState, spec: DeviceSpec, adapterW = 0): Estimate {
    if (!speaker.reachable) {
        return { watts: 0, standbyW: 0, colorFactor: 1, uncertain: spec.isEstimate };
    }

    const uncertain = spec.isEstimate || adapterW > 0;
    const idle = spec.standbyW + adapterW;

    // Ohne eigenen Verstaerker aendert die Wiedergabe kaum etwas.
    if (spec.kind === "network") {
        return { watts: idle, standbyW: idle, colorFactor: 1, uncertain };
    }
    if (spec.kind === "line") {
        return {
            watts: speaker.playing ? spec.maxW + adapterW : idle,
            standbyW: idle,
            colorFactor: 1,
            uncertain,
        };
    }
    if (!speaker.playing || speaker.muted) {
        return { watts: idle, standbyW: idle, colorFactor: 1, uncertain };
    }

    // Die abgegebene Verstaerkerleistung waechst ungefaehr mit dem Quadrat der
    // Aussteuerung - dieselbe Form wie bei der Helligkeitskurve der Lampen.
    const volume = clamp(speaker.volume, 0, 1);
    const headroom = Math.max(0, spec.maxW - spec.standbyW);
    return { watts: idle + headroom * volume ** spec.gamma, standbyW: idle, colorFactor: 1, uncertain };
}

/** Wie viel Leistung die eingestellte Farbe relativ zu Weiss zieht. */
export function colorFactor(light: LampState): number {
    const gradient = light.gradientXy;
    if (gradient !== undefined && gradient.length > 0) {
        // Gradient-Strips zeigen mehrere Farben gleichzeitig - Mittelwert ueber
        // alle Segmente, die Kanaele teilen sich denselben Treiber.
        const sum = gradient.reduce((acc, [x, y]) => acc + factorFromXy(x, y), 0);
        return sum / gradient.length;
    }
    if (light.mode === "xy" && light.xy !== undefined) {
        return factorFromXy(light.xy[0], light.xy[1]);
    }
    // Weisston- und Dimmlampen: warm- und kaltweisse Kanaele mischen sich so,
    // dass die Summe ueber den ganzen Bereich nahezu konstant bleibt.
    return 1;
}

function factorFromXy(x: number, y: number): number {
    const white = whiteness(x, y);
    if (white >= 1) return 1;

    const [r, g, b] = xyToLinearRgb(x, y);
    const [wr, wg, wb] = CHANNEL_WEIGHTS;
    const chroma = wr * r + wg * g + wb * b;

    // Weissnahe Farben laufen ueber die weissen LEDs (voller Verbrauch),
    // gesaettigte ueber die Farbkanaele (anteilig weniger).
    return white + (1 - white) * chroma;
}

/** 1.0 auf der Planckschen Kurve, 0.0 bei deutlich gesaettigten Farben. */
export function whiteness(x: number, y: number): number {
    const distance = locusDistance(x, y);
    if (distance <= LOCUS_TOLERANCE) return 1;
    return Math.max(0, 1 - (distance - LOCUS_TOLERANCE) / LOCUS_RANGE);
}

/** Abstand des Farborts zur Schwarzkoerperkurve in der xy-Ebene. */
export function locusDistance(x: number, y: number): number {
    const cct = cctMcCamy(x, y);
    const [lx, ly] = locusPoint(cct);
    return Math.hypot(x - lx, y - ly);
}

/** Naeherung der Farbtemperatur nach McCamy. */
function cctMcCamy(x: number, y: number): number {
    const denom = 0.1858 - y;
    if (Math.abs(denom) < 1e-6) return 6500;
    const n = (x - 0.332) / denom;
    const cct = 437 * n ** 3 + 3601 * n ** 2 + 6861 * n + 5517;
    // Ausserhalb der Weisskurve liefert die Formel Unsinn; das macht nichts,
    // weil der Abstand dann ohnehin gross ist - aber begrenzt werden muss sie.
    return clamp(cct, 1667, 25000);
}

/** Punkt auf der Planckschen Kurve (Naeherung nach Kim et al.). */
function locusPoint(cct: number): [number, number] {
    const t = cct;
    const cx =
        t <= 4000
            ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991
            : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039;

    let cy: number;
    if (t <= 2222) {
        cy = -1.1063814 * cx ** 3 - 1.3481102 * cx ** 2 + 2.18555832 * cx - 0.20219683;
    } else if (t <= 4000) {
        cy = -0.9549476 * cx ** 3 - 1.37418593 * cx ** 2 + 2.09137015 * cx - 0.16748867;
    } else {
        cy = 3.081758 * cx ** 3 - 5.8733867 * cx ** 2 + 3.75112997 * cx - 0.37001483;
    }
    return [cx, cy];
}

/**
 * CIE-xy-Farbort in lineare RGB-Kanalwerte (0..1, groesster Kanal = 1).
 * Keine Gamma-Korrektur: fuer die Leistung interessiert der LED-Strom, nicht
 * die wahrgenommene Helligkeit.
 */
export function xyToLinearRgb(x: number, y: number): [number, number, number] {
    if (y <= 1e-6) return [1, 1, 1];

    const z = 1 - x - y;
    const bigY = 1;
    const bigX = (bigY / y) * x;
    const bigZ = (bigY / y) * z;

    const r = Math.max(bigX * 1.656492 - bigY * 0.354851 - bigZ * 0.255038, 0);
    const g = Math.max(-bigX * 0.707196 + bigY * 1.655397 + bigZ * 0.036152, 0);
    const b = Math.max(bigX * 0.051713 - bigY * 0.121364 + bigZ * 1.01153, 0);

    const peak = Math.max(r, g, b);
    if (peak <= 0) return [1, 1, 1];
    return [r / peak, g / peak, b / peak];
}

export function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
