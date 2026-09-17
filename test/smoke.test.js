/**
 * End-to-End-Test gegen ein simuliertes Netzwerk.
 *
 * matter.js bringt einen Netzwerk-Simulator mit, deshalb laeuft der Test auch
 * dort, wo kein IPv6 und kein Multicast zur Verfuegung steht (CI, Container).
 * Getestet wird der Weg HTTP-API -> Zaehlerlogik -> Matter-Attribute.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { NetworkSimulator } from "@matter/general";
import { Environment, Network } from "@matter/main";

const CONFIG = {
    bridge: { name: "Testbridge", serialNumber: "test-0001", port: 5560, discriminator: 1234, passcode: 20202021 },
    api: { enabled: true, host: "127.0.0.1", port: 8177, token: "geheim" },
    meters: [
        { id: "haus", name: "Hausanschluss", kind: "meter", nominalVoltage: 230, phases: 1 },
        { id: "pv", name: "PV-Anlage", kind: "plug", nominalVoltage: 230, phases: 3 },
    ],
};

let storagePath;
let bridge;
let apiServer;
let store;
let baseUrl;

async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: { "content-type": "application/json", authorization: "Bearer geheim", ...options.headers },
    });
    return { status: response.status, body: await response.json() };
}

function endpointOf(id) {
    return bridge.node.parts.get("meters").parts.get(id);
}

before(async () => {
    // Simuliertes Netzwerk statt echter Sockets.
    const simulator = new NetworkSimulator();
    Environment.default.set(Network, simulator.addHost(1));

    storagePath = await mkdtemp(join(tmpdir(), "vpm-test-"));
    process.env.VPM_STORAGE = storagePath;
    process.env.VPM_CONFIG = join(storagePath, "meters.json");
    await import("node:fs/promises").then(fs =>
        fs.writeFile(process.env.VPM_CONFIG, JSON.stringify(CONFIG), "utf8"),
    );

    const { loadConfig } = await import("../dist/config.js");
    const { EnergyStore } = await import("../dist/persistence.js");
    const { createBridge } = await import("../dist/matter/bridge.js");
    const { createApiServer } = await import("../dist/http-api.js");

    const config = await loadConfig();
    store = new EnergyStore(config.storagePath);
    await store.load();
    bridge = await createBridge(config, store);
    await bridge.node.start();

    apiServer = createApiServer(config.api, bridge);
    await new Promise(resolve => apiServer.listen(config.api.port, config.api.host, resolve));
    baseUrl = `http://${config.api.host}:${config.api.port}`;
});

after(async () => {
    await new Promise(resolve => apiServer?.close(resolve));
    await bridge?.node.close();
    await rm(storagePath, { recursive: true, force: true });
});

describe("Matter-Bridge", () => {
    it("startet ungekoppelt und liefert Kopplungscodes", () => {
        const pairing = bridge.pairing();
        assert.equal(pairing.commissioned, false);
        assert.match(pairing.manualPairingCode, /^\d{11}$/);
        assert.match(pairing.qrPairingCode, /^MT:/);
    });

    it("legt fuer jeden konfigurierten Zaehler einen Endpoint an", () => {
        assert.deepEqual([...bridge.meters.keys()], ["haus", "pv"]);
        assert.equal(endpointOf("haus").state.bridgedDeviceBasicInformation.nodeLabel, "Hausanschluss");
        assert.equal(endpointOf("pv").state.bridgedDeviceBasicInformation.nodeLabel, "PV-Anlage");
    });

    it("meldet unterschiedliche uniqueId und serialNumber", () => {
        const info = endpointOf("haus").state.bridgedDeviceBasicInformation;
        assert.notEqual(info.uniqueId, info.serialNumber);
    });
});

describe("HTTP-API", () => {
    it("antwortet ohne Token auf /health", async () => {
        const response = await fetch(`${baseUrl}/health`);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).meters, 2);
    });

    it("weist /api ohne Token ab", async () => {
        const response = await fetch(`${baseUrl}/api/meters`);
        assert.equal(response.status, 401);
    });

    it("schreibt Leistung in die Matter-Attribute", async () => {
        const { status, body } = await request("/api/meters/haus", {
            method: "POST",
            body: JSON.stringify({ power: 2300 }),
        });
        assert.equal(status, 200);
        assert.equal(body.power, 2300);

        const state = endpointOf("haus").state.electricalPowerMeasurement;
        assert.equal(state.activePower, 2_300_000, "2300 W entsprechen 2300000 mW");
        assert.equal(state.voltage, 230_000);
        // 2300 W / 230 V / 1 Phase = 10 A
        assert.equal(state.activeCurrent, 10_000);
    });

    it("rechnet den Strom bei drei Phasen pro Phase", async () => {
        await request("/api/meters/pv", { method: "POST", body: JSON.stringify({ power: -6900 }) });
        const state = endpointOf("pv").state.electricalPowerMeasurement;
        assert.equal(state.activePower, -6_900_000, "Einspeisung ist negativ");
        // 6900 W / 230 V / 3 Phasen = 10 A
        assert.equal(state.activeCurrent, 10_000);
    });

    it("uebernimmt einen expliziten Stromwert", async () => {
        await request("/api/meters/haus", { method: "POST", body: JSON.stringify({ power: 2300, current: 7.5 }) });
        assert.equal(endpointOf("haus").state.electricalPowerMeasurement.activeCurrent, 7_500);
    });

    it("aktualisiert mehrere Zaehler in einem Aufruf", async () => {
        const { status, body } = await request("/api/meters", {
            method: "POST",
            body: JSON.stringify({ haus: { power: 500 }, pv: { power: -1000 } }),
        });
        assert.equal(status, 200);
        assert.equal(body.find(meter => meter.id === "haus").power, 500);
        assert.equal(body.find(meter => meter.id === "pv").power, -1000);
    });

    it("lehnt unbekannte Zaehler und kaputte Bodies ab", async () => {
        assert.equal((await request("/api/meters/gibtsnicht", { method: "POST", body: "{}" })).status, 404);
        assert.equal((await request("/api/meters/haus", { method: "POST", body: "{}" })).status, 400);
        assert.equal(
            (await request("/api/meters/haus", { method: "POST", body: JSON.stringify({ power: "viel" }) })).status,
            400,
        );
    });

    it("liefert die Kopplungsinfos", async () => {
        const { status, body } = await request("/api/commissioning");
        assert.equal(status, 200);
        assert.equal(body.commissioned, false);
        assert.match(body.qrPairingCode, /^MT:/);
    });
});

describe("Energiezaehlung", () => {
    it("integriert Leistung ueber die Zeit und persistiert den Stand", async () => {
        const meter = bridge.meters.get("haus");
        await request("/api/meters/haus", { method: "POST", body: JSON.stringify({ power: 3600 }) });
        const before = meter.snapshot.energyImported;

        await new Promise(resolve => setTimeout(resolve, 1100));
        await meter.tick();

        const after = meter.snapshot.energyImported;
        // 3600 W ueber gut eine Sekunde sind rund 1 Wh = 0,001 kWh.
        assert.ok(after > before, "Zaehlerstand muss steigen");
        assert.ok(after - before >= 0.001 && after - before < 0.0015, `unerwarteter Zuwachs: ${after - before}`);

        const energyState = endpointOf("haus").state.electricalEnergyMeasurement.cumulativeEnergyImported;
        assert.ok(Number(energyState.energy) > 0, "Matter-Attribut muss den Stand tragen");

        await store.flush(true);
        const persisted = JSON.parse(await readFile(join(storagePath, "energy-state.json"), "utf8"));
        assert.ok(persisted.meters.haus.importedMwh > 0);
    });

    it("zaehlt Einspeisung getrennt", async () => {
        const meter = bridge.meters.get("pv");
        await request("/api/meters/pv", { method: "POST", body: JSON.stringify({ power: -3600 }) });
        await new Promise(resolve => setTimeout(resolve, 600));
        await meter.tick();

        const snapshot = meter.snapshot;
        assert.equal(snapshot.energyImported, 0, "Einspeisung darf nicht als Bezug zaehlen");
        assert.ok(snapshot.energyExported > 0);
    });

    it("stoppt die Integration, sobald absolute Staende geliefert werden", async () => {
        const meter = bridge.meters.get("haus");
        await request("/api/meters/haus", {
            method: "POST",
            body: JSON.stringify({ power: 3600, energyImported: 42 }),
        });
        assert.equal(meter.snapshot.energyMode, "external");
        assert.equal(meter.snapshot.energyImported, 42);

        await new Promise(resolve => setTimeout(resolve, 300));
        await meter.tick();
        assert.equal(meter.snapshot.energyImported, 42, "externe Staende duerfen nicht weiterlaufen");
    });
});

describe("Konfiguration", () => {
    it("behandelt token: null als 'kein Token'", async () => {
        const { loadConfig } = await import("../dist/config.js");
        const path = join(storagePath, "no-token.json");
        const fs = await import("node:fs/promises");
        await fs.writeFile(path, JSON.stringify({ api: { token: null }, meters: CONFIG.meters }), "utf8");

        const previous = process.env.VPM_CONFIG;
        process.env.VPM_CONFIG = path;
        try {
            const config = await loadConfig();
            assert.equal(config.api.token, undefined);
        } finally {
            process.env.VPM_CONFIG = previous;
        }
    });

    it("liest die mitgelieferte Beispielkonfiguration", async () => {
        const { loadConfig } = await import("../dist/config.js");
        const previous = process.env.VPM_CONFIG;
        process.env.VPM_CONFIG = "config/meters.example.json";
        try {
            const config = await loadConfig();
            assert.deepEqual(
                config.meters.map(meter => meter.id),
                ["hausanschluss", "pv", "demo"],
            );
            assert.equal(config.api.token, undefined);
            // Die Quellen stehen im Beispiel mit ihren Standardwerten drin.
            assert.equal(config.sources.hue.enabled, true);
            assert.equal(config.sources.hue.bridgeWatts, 1.9);
            assert.equal(config.sources.sonos.enabled, true);
            assert.equal(config.sources.sonos.mainsVoltage, "230");
            assert.deepEqual(Object.keys(config.sources.hue.overrides), ["by_model", "by_light"]);
        } finally {
            process.env.VPM_CONFIG = previous;
        }
    });

    it("nimmt die Hue-Zugangsdaten aus der Umgebung", async () => {
        const { loadConfig } = await import("../dist/config.js");
        const path = join(storagePath, "hue-env.json");
        const fs = await import("node:fs/promises");
        // In der Datei stehen andere Werte - die Umgebung muss gewinnen.
        await fs.writeFile(
            path,
            JSON.stringify({ meters: CONFIG.meters, sources: { hue: { enabled: false, bridgeIp: "1.1.1.1", appKey: "alt" } } }),
            "utf8",
        );

        const previous = { ...process.env };
        process.env.VPM_CONFIG = path;
        process.env.VPM_HUE_ENABLED = "true";
        process.env.VPM_HUE_BRIDGE_IP = "192.168.1.42";
        process.env.VPM_HUE_APP_KEY = "app-key-aus-der-umgebung";
        try {
            const config = await loadConfig();
            assert.equal(config.sources.hue.enabled, true);
            assert.equal(config.sources.hue.bridgeIp, "192.168.1.42");
            assert.equal(config.sources.hue.appKey, "app-key-aus-der-umgebung");
        } finally {
            process.env.VPM_CONFIG = previous.VPM_CONFIG;
            delete process.env.VPM_HUE_ENABLED;
            delete process.env.VPM_HUE_BRIDGE_IP;
            delete process.env.VPM_HUE_APP_KEY;
        }
    });

    it("laesst leere Umgebungsvariablen die Datei nicht ueberschreiben", async () => {
        const { loadConfig } = await import("../dist/config.js");
        const path = join(storagePath, "hue-file.json");
        const fs = await import("node:fs/promises");
        await fs.writeFile(
            path,
            JSON.stringify({ meters: CONFIG.meters, sources: { hue: { enabled: true, bridgeIp: "10.0.0.7", appKey: "aus-der-datei" } } }),
            "utf8",
        );

        const previous = process.env.VPM_CONFIG;
        process.env.VPM_CONFIG = path;
        // Genau das liefert docker compose fuer eine nicht gesetzte .env-Variable.
        process.env.VPM_HUE_BRIDGE_IP = "";
        process.env.VPM_HUE_APP_KEY = "";
        process.env.VPM_HUE_ENABLED = "";
        try {
            const config = await loadConfig();
            assert.equal(config.sources.hue.enabled, true);
            assert.equal(config.sources.hue.bridgeIp, "10.0.0.7");
            assert.equal(config.sources.hue.appKey, "aus-der-datei");
        } finally {
            process.env.VPM_CONFIG = previous;
            delete process.env.VPM_HUE_ENABLED;
            delete process.env.VPM_HUE_BRIDGE_IP;
            delete process.env.VPM_HUE_APP_KEY;
        }
    });

    it("liest das Schreibintervall aus der Datei und laesst die Umgebung vorgehen", async () => {
        const { loadConfig } = await import("../dist/config.js");
        const fs = await import("node:fs/promises");
        const path = join(storagePath, "interval.json");
        await fs.writeFile(path, JSON.stringify({ meters: CONFIG.meters, integrationIntervalSeconds: 3600 }), "utf8");

        const previous = process.env.VPM_CONFIG;
        process.env.VPM_CONFIG = path;
        try {
            assert.equal((await loadConfig()).integrationIntervalSeconds, 3600, "Wert aus der Datei");

            process.env.VPM_INTEGRATION_INTERVAL = "42";
            assert.equal((await loadConfig()).integrationIntervalSeconds, 42, "Umgebung sticht die Datei");
        } finally {
            delete process.env.VPM_INTEGRATION_INTERVAL;
            process.env.VPM_CONFIG = previous;
        }
    });

    it("weist ein Schreibintervall von 0 ab", async () => {
        const { loadConfig, ConfigError } = await import("../dist/config.js");
        const fs = await import("node:fs/promises");
        const path = join(storagePath, "interval-null.json");
        // 0 waere eine Endlosschleife im Timer, nicht "nie schreiben".
        await fs.writeFile(path, JSON.stringify({ meters: CONFIG.meters, integrationIntervalSeconds: 0 }), "utf8");

        const previous = process.env.VPM_CONFIG;
        process.env.VPM_CONFIG = path;
        try {
            await assert.rejects(() => loadConfig(), ConfigError);
        } finally {
            process.env.VPM_CONFIG = previous;
        }
    });

    it("weist ungueltige Zaehler-IDs ab", async () => {
        const { loadConfig, ConfigError } = await import("../dist/config.js");
        const path = join(storagePath, "bad-id.json");
        const fs = await import("node:fs/promises");
        await fs.writeFile(path, JSON.stringify({ meters: [{ id: "Haus Anschluss" }] }), "utf8");

        const previous = process.env.VPM_CONFIG;
        process.env.VPM_CONFIG = path;
        try {
            await assert.rejects(() => loadConfig(), ConfigError);
        } finally {
            process.env.VPM_CONFIG = previous;
        }
    });
});

describe("Simulation", () => {
    it("erzeugt Werte innerhalb der konfigurierten Grenzen", async () => {
        const { VirtualMeter } = await import("../dist/meter.js");
        const { EnergyStore } = await import("../dist/persistence.js");

        const meter = new VirtualMeter(
            {
                id: "sim",
                name: "Simuliert",
                kind: "meter",
                nominalVoltage: 230,
                phases: 1,
                initialEnergyImportedKwh: 0,
                initialEnergyExportedKwh: 0,
                simulation: { enabled: true, minWatts: 500, maxWatts: 1500, intervalSeconds: 1 },
            },
            new EnergyStore(storagePath),
        );

        meter.startSimulation();
        try {
            assert.ok(meter.snapshot.power >= 500 && meter.snapshot.power <= 1500);
            await new Promise(resolve => setTimeout(resolve, 1200));
            const { power, energyImported } = meter.snapshot;
            assert.ok(power >= 500 && power <= 1500, `Wert ausserhalb der Grenzen: ${power}`);
            assert.ok(energyImported > 0, "Simulation muss Energie erzeugen");
        } finally {
            meter.stopSimulation();
        }
    });
});

describe("Geraetetypen", () => {
    it("gibt dem plug-Zaehler zusaetzlich einen Schalter", () => {
        const plug = endpointOf("pv");
        assert.ok(plug.state.onOff !== undefined, "plug muss den OnOff-Cluster tragen");
        assert.ok(plug.state.electricalPowerMeasurement !== undefined, "plug muss trotzdem messen");
        assert.equal(endpointOf("haus").state.onOff, undefined, "meter braucht keinen Schalter");
    });
});
