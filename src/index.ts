/**
 * Einstiegspunkt: Konfiguration laden, Matter-Knoten und HTTP-API starten,
 * Zaehlerstaende regelmaessig fortschreiben und beim Beenden sichern.
 */
import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { Logger, LogLevel } from "@matter/main";
import { ConfigError, loadConfig, type AppConfig } from "./config.js";
import { createApiServer } from "./http-api.js";
import { createBridge, type Bridge } from "./matter/bridge.js";
import { EnergyStore } from "./persistence.js";
import { createSourceManager } from "./sources/manager.js";

const logger = Logger.get("VirtualPowerMeter");

function configureLogging(): void {
    const level = process.env.VPM_LOG_LEVEL?.toUpperCase();
    if (level !== undefined && level in LogLevel) {
        Logger.level = LogLevel[level as keyof typeof LogLevel] as LogLevel;
    }
}

function logPairing(bridge: Bridge, config: AppConfig): void {
    const pairing = bridge.pairing();
    if (pairing.commissioned) {
        logger.notice(`Bridge ist gekoppelt (${pairing.fabrics} Fabric(s)).`);
        logger.notice("Weitere Ecosysteme koppelt man ueber die Teilen-Funktion der bereits gekoppelten App.");
        return;
    }

    // Den QR-Code als ASCII-Art zeichnet matter.js beim Start selbst ins Log,
    // hier stehen nur noch die Codes zum Abtippen.
    logger.notice("Bridge ist noch nicht gekoppelt.");
    logger.notice(`Manueller Kopplungscode: ${pairing.manualPairingCode}`);
    logger.notice(`QR-Code-Inhalt: ${pairing.qrPairingCode}`);
    logger.notice(`Discriminator: ${config.bridge.discriminator}, Passcode: ${config.bridge.passcode}`);
}

async function main(): Promise<void> {
    configureLogging();

    const config = await loadConfig();
    await mkdir(config.storagePath, { recursive: true });

    const store = new EnergyStore(config.storagePath);
    await store.load();

    const bridge = await createBridge(config, store);

    // Quellen legen ihre Zaehler selbst an. Die bereits bekannten entstehen noch
    // vor dem Start des Knotens, damit die Geraete im Controller nicht kurz
    // verschwinden, wenn Hue oder Sonos gerade nicht antworten.
    const sources = createSourceManager(config, bridge);
    await sources?.prepare();

    try {
        await bridge.node.start();
    } catch (error) {
        // Ohne close() bleibt der Storage-Lock liegen und der naechste Start
        // meldet "orphaned lock" - im Restart-Loop bei jedem Versuch erneut.
        await bridge.node.close().catch(() => undefined);
        throw error;
    }

    logger.notice(
        `Matter-Knoten "${config.bridge.name}" laeuft auf Port ${config.bridge.port} mit ${bridge.meters.size} Zaehler(n).`,
    );
    logPairing(bridge, config);

    let apiServer: Server | undefined;
    if (config.api.enabled) {
        apiServer = createApiServer(config.api, bridge, sources);
        await new Promise<void>((resolve, reject) => {
            apiServer?.once("error", reject);
            apiServer?.listen(config.api.port, config.api.host, resolve);
        });
        logger.notice(`HTTP-API auf http://${config.api.host}:${config.api.port} bereit.`);
        if (config.api.token === undefined) {
            logger.warn("Die HTTP-API laeuft ohne Token. Fuer Zugriff aus dem LAN VPM_API_TOKEN setzen.");
        }
    }

    for (const meter of bridge.meters.values()) {
        meter.startSimulation();
    }

    // Erst jetzt die Quellen abfragen: die Sonos-Suche braucht ein paar Sekunden,
    // bis dahin sind Knoten und API schon bereit.
    if (sources !== undefined) {
        await sources.start();
        logger.notice(`Quellen aktiv, ${bridge.meters.size} Zaehler insgesamt.`);
    }

    // Auch ohne neue Messwerte laeuft der Energiezaehler weiter - der Tick
    // integriert die zuletzt gemeldete Leistung und sichert die Staende.
    const ticker = setInterval(() => {
        void (async () => {
            for (const meter of bridge.meters.values()) {
                await meter.tick();
            }
            await store.flush();
        })().catch(error => logger.error("Fehler beim Fortschreiben der Zaehlerstaende:", error));
    }, config.integrationIntervalSeconds * 1000);

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.notice(`${signal} empfangen, fahre herunter.`);
        clearInterval(ticker);
        await sources?.stop();
        for (const meter of bridge.meters.values()) {
            meter.stopSimulation();
            await meter.tick();
        }
        await store.flush(true);
        await new Promise<void>(resolve => {
            if (apiServer === undefined) return resolve();
            apiServer.close(() => resolve());
        });
        await bridge.node.close();
        process.exit(0);
    };

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => void shutdown(signal));
    }
}

/**
 * Die typischen Startfehler auf einem NAS sind Netzwerkprobleme, deren
 * Originalmeldung nicht verraet, woran es liegt. Deshalb hier ein Klartext-Hinweis.
 */
function explainStartupError(error: unknown): string | undefined {
    const text = collectErrorText(error);

    if (text.includes("EAFNOSUPPORT") || text.includes("EPROTONOSUPPORT")) {
        return [
            "Der Container kann keinen IPv6-Socket oeffnen.",
            "Matter setzt IPv6 zwingend voraus - reines IPv4 genuegt nicht.",
            "Auf dem NAS IPv6 aktivieren (mindestens Link-Local) und im Docker-Daemon",
            'IPv6 einschalten ("ipv6": true in /etc/docker/daemon.json), danach Container neu starten.',
        ].join(" ");
    }
    // matter.js meldet den belegten Port als "[address-in-use] Cannot bind ...",
    // der Node-Code EADDRINUSE taucht darin nicht zwingend auf.
    if (text.includes("EADDRINUSE") || text.includes("address-in-use") || text.includes("already in use")) {
        return [
            "Ein benoetigter Port ist belegt.",
            "5540/udp haelt meist ein anderer Matter-Dienst (z. B. der Matter-Server von Home Assistant,",
            "eine Bridge wie Homebridge/ioBroker) oder eine zweite Instanz dieses Containers;",
            "5353/udp gehoert dem Avahi/Bonjour-Dienst des NAS.",
            "Belegung pruefen mit: ss -ulpn | grep -E '5540|5353'   bzw.   docker ps",
            "Dann entweder den fremden Dienst stoppen oder VPM_MATTER_PORT auf einen freien Port setzen (z. B. 5541).",
        ].join(" ");
    }
    if (text.includes("EACCES")) {
        return [
            "Zugriff verweigert - vermutlich darf der Container nicht in das Datenverzeichnis schreiben.",
            "Den gemounteten Ordner dem Container-Benutzer zuweisen (z. B. chown -R 1000:1000 ./data)",
            "oder Ports unter 1024 vermeiden.",
        ].join(" ");
    }
    return undefined;
}

function collectErrorText(error: unknown): string {
    const parts: string[] = [];
    let current: unknown = error;
    // Fehlerketten von matter.js transportieren die eigentliche Ursache in `cause`.
    for (let depth = 0; current !== undefined && current !== null && depth < 10; depth++) {
        parts.push(String(current));
        current = (current as { cause?: unknown }).cause;
    }
    return parts.join(" | ");
}

main().catch(error => {
    if (error instanceof ConfigError) {
        console.error(`Konfigurationsfehler: ${error.message}`);
    } else {
        console.error("Start fehlgeschlagen:", error);
        const hint = explainStartupError(error);
        if (hint !== undefined) console.error(`\nHinweis: ${hint}`);
    }
    process.exit(1);
});
