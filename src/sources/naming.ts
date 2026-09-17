/**
 * Stabile Zaehler-IDs aus Raumnamen.
 *
 * Die ID landet in `uniqueId` und `serialNumber` des Bridged Device. Aendert sie
 * sich, ist das fuer den Controller ein neues Geraet - deshalb muss sie aus
 * demselben Raumnamen immer dasselbe ergeben, auch ueber Neustarts hinweg.
 */
import { createHash } from "node:crypto";

/** Matter-Endpoint-IDs duerfen bei uns hoechstens 32 Zeichen lang sein. */
const MAX_ID_LENGTH = 32;

const UMLAUTS: Array<[RegExp, string]> = [
    [/ä/g, "ae"],
    [/ö/g, "oe"],
    [/ü/g, "ue"],
    [/ß/g, "ss"],
];

/** "Büro & Flur" -> "buero-flur" */
export function slug(text: string): string {
    let value = (text ?? "").toLowerCase();
    for (const [pattern, replacement] of UMLAUTS) value = value.replace(pattern, replacement);
    return value
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function shortHash(text: string): string {
    return createHash("sha256").update(text).digest("hex").slice(0, 6);
}

/**
 * Zaehler-ID fuer einen Raum: `<praefix>-<raum>`, bei zu langen oder
 * kollidierenden Namen mit einem kurzen Hash des Originalnamens.
 */
export function meterIdFor(prefix: string, room: string, taken: ReadonlySet<string> = new Set()): string {
    const base = slug(room);
    const plain = base === "" ? prefix : `${prefix}-${base}`;

    if (plain.length <= MAX_ID_LENGTH && !taken.has(plain)) return plain;

    // Zu lang oder schon vergeben: eindeutig machen, ohne die Lesbarkeit
    // ganz aufzugeben. Der Hash haengt am Originalnamen, nicht am gekuerzten.
    const suffix = `-${shortHash(`${prefix}:${room}`)}`;
    const head = plain.slice(0, MAX_ID_LENGTH - suffix.length).replace(/-+$/, "");
    return `${head}${suffix}`;
}
