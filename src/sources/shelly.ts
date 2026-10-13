/**
 * Zugriff auf Shelly-Geraete im lokalen Netz.
 *
 * Anders als Hue und Sonos misst ein Shelly selbst - hier wird nichts
 * geschaetzt, sondern nur abgelesen. Unterstuetzt werden beide API-Familien:
 *
 *   Gen1 (Shelly Plug S, 1PM, 2.5, EM, 3EM):  GET /status
 *   Gen2+ (Plus, Pro, Gen3, Gen4, Mini):      GET /rpc/Shelly.GetStatus
 *
 * Welche Familie ein Geraet spricht, verraet `GET /shelly`. Mehrkanalige Geraete
 * (2PM, 3EM, Pro 4PM ...) werden zu einem Wert aufsummiert.
 */

const TIMEOUT_MS = 5000;

export class ShellyError extends Error {}

/** Ein Messwert, so wie ihn der Zaehler braucht. */
export interface ShellyReading {
    /** Wirkleistung in Watt, ueber alle Kanaele summiert. Negativ = Einspeisung. */
    power: number;
    /** Mittlere Spannung der Kanaele in Volt, falls das Geraet sie meldet. */
    voltage?: number;
    /** Strom in Ampere - nur bei genau einem Kanal, eine Summe ueber Phasen waere sinnlos. */
    current?: number;
    /** Anzahl der Messkanaele, die eingeflossen sind. */
    channels: number;
}

interface Channel {
    power: number;
    voltage?: number;
    current?: number;
}

async function getJson(url: string): Promise<Record<string, any>> {
    let response: Response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
        const reason = (error as Error)?.name === "TimeoutError" ? `Zeitueberschreitung nach ${TIMEOUT_MS} ms` : String(error);
        throw new ShellyError(`nicht erreichbar: ${reason}`);
    }
    if (response.status === 401) {
        throw new ShellyError("verlangt ein Passwort - den Zugriffsschutz in der Shelly-App fuer das lokale Netz abschalten");
    }
    if (!response.ok) throw new ShellyError(`HTTP ${response.status} (${url})`);
    try {
        return (await response.json()) as Record<string, any>;
    } catch {
        throw new ShellyError("unverstaendliche Antwort");
    }
}

function num(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Kanaele aus einer Gen2+-Statusantwort. Die Komponenten heissen `<typ>:<n>`;
 * je nach Geraet traegt eine andere die Leistung.
 */
export function channelsGen2(status: Record<string, any>): Channel[] {
    const channels: Channel[] = [];
    for (const [key, component] of Object.entries(status)) {
        if (typeof component !== "object" || component === null) continue;
        const type = key.split(":")[0];

        switch (type) {
            // Schalt- und Messkanaele: Plus 1PM, Plus Plug S, Pro 4PM, PM Mini, Dimmer ...
            case "switch":
            case "pm1":
            case "cover":
            case "light": {
                const power = num(component.apower);
                if (power === undefined) continue; // Kanal ohne Messung (z. B. Plus 1 ohne PM)
                channels.push({ power, voltage: num(component.voltage), current: num(component.current) });
                break;
            }
            // Dreiphasiger Energiezaehler (Pro 3EM): die Summe liefert das Geraet selbst.
            case "em": {
                const power = num(component.total_act_power);
                if (power === undefined) continue;
                const voltages = [component.a_voltage, component.b_voltage, component.c_voltage]
                    .map(num)
                    .filter((value): value is number => value !== undefined);
                channels.push({
                    power,
                    voltage: voltages.length > 0 ? average(voltages) : undefined,
                    // Mehrphasig - den Strom leitet der Zaehler aus Leistung und Phasenzahl ab.
                });
                break;
            }
            // Einphasige Messkanaele: Pro EM, Pro 3EM im Einzelphasen-Modus, EM Gen3.
            case "em1": {
                const power = num(component.act_power);
                if (power === undefined) continue;
                channels.push({ power, voltage: num(component.voltage), current: num(component.current) });
                break;
            }
        }
    }
    return channels;
}

/** Kanaele aus einer Gen1-Statusantwort. */
export function channelsGen1(status: Record<string, any>): Channel[] {
    // Shelly EM / 3EM: emeters, sonst Schaltaktoren mit meters.
    if (Array.isArray(status.emeters) && status.emeters.length > 0) {
        return status.emeters
            .filter((meter: any) => meter?.is_valid !== false && num(meter?.power) !== undefined)
            .map((meter: any) => ({ power: meter.power, voltage: num(meter.voltage), current: num(meter.current) }));
    }
    if (Array.isArray(status.meters)) {
        // Gen1-Aktoren melden die Spannung, wenn ueberhaupt, einmal fuer das ganze Geraet.
        const voltage = num(status.voltage);
        return status.meters
            .filter((meter: any) => meter?.is_valid !== false && num(meter?.power) !== undefined)
            .map((meter: any) => ({ power: meter.power, voltage }));
    }
    return [];
}

/** Kanaele zu einem Messwert zusammenfassen. */
export function combine(channels: Channel[]): ShellyReading {
    if (channels.length === 0) {
        throw new ShellyError("meldet keine Leistung - kein Shelly mit Strommessung?");
    }
    const voltages = channels.map(channel => channel.voltage).filter((value): value is number => value !== undefined && value > 0);
    return {
        power: channels.reduce((sum, channel) => sum + channel.power, 0),
        voltage: voltages.length > 0 ? average(voltages) : undefined,
        current: channels.length === 1 ? channels[0]!.current : undefined,
        channels: channels.length,
    };
}

function average(values: number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export class ShellyDevice {
    readonly ip: string;
    /** 1 = Gen1, 2 = Gen2 und neuer (alle sprechen dieselbe RPC-API). */
    generation?: 1 | 2;
    model?: string;
    /** Name, den der Benutzer in der Shelly-App vergeben hat. */
    name?: string;

    constructor(ip: string) {
        this.ip = ip;
    }

    /** Fragt die Geraeteinfo ab. Wird beim ersten Poll automatisch nachgeholt. */
    async identify(): Promise<void> {
        const info = await getJson(`http://${this.ip}/shelly`);
        // Gen2+ meldet "gen": 2, 3, 4 ...; Gen1 kennt das Feld nicht.
        this.generation = typeof info.gen === "number" && info.gen >= 2 ? 2 : 1;
        this.model = (info.model ?? info.type ?? info.app) as string | undefined;
        this.name = typeof info.name === "string" && info.name !== "" ? info.name : undefined;
    }

    async poll(): Promise<ShellyReading> {
        if (this.generation === undefined) await this.identify();

        if (this.generation === 2) {
            return combine(channelsGen2(await getJson(`http://${this.ip}/rpc/Shelly.GetStatus`)));
        }
        return combine(channelsGen1(await getJson(`http://${this.ip}/status`)));
    }
}
