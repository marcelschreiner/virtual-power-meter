/**
 * Durchstich fuer die Hue-Quelle: nachgebaute Bridge (echtes HTTPS mit
 * selbstsigniertem Zertifikat, wie im Original) -> CLIP-v2-Auswertung ->
 * Schaetzung -> Raumsummen -> Matter-Attribute.
 *
 * Das Zertifikat unter `fixtures/` gilt nur fuer localhost und ist ausschliesslich
 * fuer diesen Test da.
 */
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { NetworkSimulator } from "@matter/general";
import { Environment, Network } from "@matter/main";

/** Zwei Raeume, eine Lampe ohne Raum, eine stromlose Lampe. */
const DEVICES = [
    {
        id: "dev-1",
        product_data: { model_id: "LCT015", product_name: "Hue color lamp", product_archetype: "sultan_bulb" },
        metadata: { name: "Stehlampe" },
        services: [{ rtype: "light", rid: "light-1" }],
    },
    {
        id: "dev-2",
        product_data: { model_id: "LCT015", product_name: "Hue color lamp", product_archetype: "sultan_bulb" },
        metadata: { name: "Deckenlampe" },
        services: [{ rtype: "light", rid: "light-2" }],
    },
    {
        id: "dev-3",
        product_data: { model_id: "LTW010", product_name: "Hue ambiance lamp", product_archetype: "ceiling_round" },
        metadata: { name: "Kuechenlampe" },
        services: [{ rtype: "light", rid: "light-3" }],
    },
    {
        id: "dev-4",
        product_data: { model_id: "LCT015", product_name: "Hue color lamp", product_archetype: "sultan_bulb" },
        metadata: { name: "Flurlampe" },
        services: [{ rtype: "light", rid: "light-4" }],
    },
    {
        id: "dev-bridge",
        product_data: { model_id: "BSB002", product_name: "Philips hue bridge" },
        metadata: { name: "Testbridge" },
        services: [{ rtype: "bridge", rid: "bridge-1" }],
    },
];

const ROOMS = [
    { id: "room-1", metadata: { name: "Wohnzimmer" }, children: [{ rtype: "device", rid: "dev-1" }, { rtype: "device", rid: "dev-2" }] },
    { id: "room-2", metadata: { name: "Kueche" }, children: [{ rtype: "device", rid: "dev-3" }] },
];

const LIGHTS = [
    // an, volle Helligkeit, warmweiss -> volle Leistung (10 W)
    {
        id: "light-1",
        metadata: { name: "Stehlampe", archetype: "sultan_bulb" },
        on: { on: true },
        dimming: { brightness: 100 },
        color: { xy: { x: 0.4573, y: 0.41 } },
        color_temperature: { mirek: 370, mirek_valid: false },
    },
    // aus -> nur Standby (0.4 W)
    {
        id: "light-2",
        metadata: { name: "Deckenlampe", archetype: "sultan_bulb" },
        on: { on: false },
        dimming: { brightness: 60 },
        color: { xy: { x: 0.4573, y: 0.41 } },
    },
    // Weisstonlampe an, 50 % -> 0.3 + 0.25 + (6.8 - 0.55) * 0.25 = 2.1125 W
    {
        id: "light-3",
        metadata: { name: "Kuechenlampe", archetype: "ceiling_round" },
        on: { on: true },
        dimming: { brightness: 50 },
        color_temperature: { mirek: 370, mirek_valid: true },
    },
    // stromlos (Zigbee meldet connectivity_issue) -> 0 W
    {
        id: "light-4",
        metadata: { name: "Flurlampe", archetype: "sultan_bulb" },
        on: { on: true },
        dimming: { brightness: 100 },
        color: { xy: { x: 0.4573, y: 0.41 } },
    },
];

const ZIGBEE = [
    { id: "z-1", owner: { rtype: "device", rid: "dev-1" }, status: "connected" },
    { id: "z-2", owner: { rtype: "device", rid: "dev-2" }, status: "connected" },
    { id: "z-3", owner: { rtype: "device", rid: "dev-3" }, status: "connected" },
    { id: "z-4", owner: { rtype: "device", rid: "dev-4" }, status: "connectivity_issue" },
];

let server;
let storagePath;
let bridge;
let manager;
let config;
let requestedKeys = [];

function baseConfig(port, storage) {
    return {
        bridge: {
            name: "Testbridge",
            vendorName: "Test",
            vendorId: 0xfff1,
            productName: "Test",
            productId: 0x8001,
            serialNumber: "test-hue-0001",
            passcode: 20202021,
            discriminator: 2345,
            port: 5561,
        },
        api: { enabled: false, host: "127.0.0.1", port: 0, token: undefined },
        meters: [],
        sources: {
            hue: {
                enabled: true,
                bridgeIp: `127.0.0.1:${port}`,
                appKey: "test-app-key",
                bridgeWatts: 1.9,
                gamma: 2.0,
                // Lang genug, dass waehrend des Tests kein zweiter Durchlauf dazwischenfunkt.
                intervalSeconds: 3600,
                overrides: {},
            },
            sonos: {
                enabled: false,
                ips: [],
                mainsVoltage: "230",
                usbAdapterWatts: 0.5,
                intervalSeconds: 3,
                overrides: {},
            },
        },
        storagePath: storage,
        integrationIntervalSeconds: 10,
    };
}

before(async () => {
    Environment.default.set(Network, new NetworkSimulator().addHost(1));
    storagePath = await mkdtemp(join(tmpdir(), "vpm-hue-"));

    const [key, cert] = await Promise.all([
        readFile(new URL("./fixtures/localhost-key.pem", import.meta.url)),
        readFile(new URL("./fixtures/localhost-cert.pem", import.meta.url)),
    ]);

    server = createServer({ key, cert }, (request, response) => {
        requestedKeys.push(request.headers["hue-application-key"]);
        const resource = request.url.replace("/clip/v2/resource/", "");
        const data = { device: DEVICES, room: ROOMS, light: LIGHTS, zigbee_connectivity: ZIGBEE }[resource];
        if (data === undefined) {
            response.writeHead(404).end("{}");
            return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ errors: [], data }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

    config = baseConfig(server.address().port, storagePath);

    const { createBridge } = await import("../dist/matter/bridge.js");
    const { EnergyStore } = await import("../dist/persistence.js");
    const { SourceManager } = await import("../dist/sources/manager.js");

    const store = new EnergyStore(storagePath);
    await store.load();
    bridge = await createBridge(config, store);

    manager = new SourceManager(config, bridge);
    await manager.prepare();
    await bridge.node.start();
    await manager.start();
});

after(async () => {
    await manager?.stop();
    await bridge?.node.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(storagePath, { recursive: true, force: true });
});

function endpointOf(id) {
    return bridge.node.parts.get("meters").parts.get(id);
}

describe("Hue als Quelle", () => {
    it("legt je Raum einen Zaehler an, plus einen fuer die Bridge", () => {
        assert.deepEqual(
            [...bridge.meters.keys()].sort(),
            ["hue-bridge", "hue-kueche", "hue-ohne-raum", "hue-wohnzimmer"],
        );
    });

    it("schickt den App-Key mit", () => {
        assert.ok(requestedKeys.length > 0);
        assert.ok(
            requestedKeys.every(key => key === "test-app-key"),
            "jede Anfrage traegt den App-Key im Header",
        );
    });

    it("summiert die Lampen eines Raums", () => {
        // Stehlampe an (10 W) + Deckenlampe aus (0.4 W)
        assert.equal(bridge.meters.get("hue-wohnzimmer").snapshot.power, 10.4);
        // Weisstonlampe auf 50 %: 0.3 + 0.25 + (6.8 - 0.3 - 0.25) * 0.25
        assert.equal(bridge.meters.get("hue-kueche").snapshot.power, 2.11);
    });

    it("fuehrt die Grundlast der Bridge als eigenen Zaehler", () => {
        const meter = bridge.meters.get("hue-bridge");
        assert.equal(meter.snapshot.power, 1.9);
        assert.equal(meter.snapshot.name, "Testbridge Grundlast", "der Name kommt von der Bridge selbst");
    });

    it("zaehlt eine stromlose Lampe mit 0 W und meldet den Raum als nicht erreichbar", () => {
        const meter = bridge.meters.get("hue-ohne-raum");
        assert.equal(meter.snapshot.power, 0);
        assert.equal(meter.snapshot.reachable, false);
        assert.equal(endpointOf("hue-ohne-raum").state.bridgedDeviceBasicInformation.reachable, false);
    });

    it("schreibt die Werte in die Matter-Attribute", () => {
        const state = endpointOf("hue-wohnzimmer").state;
        assert.equal(state.electricalPowerMeasurement.activePower, 10_400, "10.4 W in mW");
        assert.equal(state.electricalPowerMeasurement.voltage, 230_000);
        // 10.4 W / 230 V = 0.0452 A
        assert.equal(state.electricalPowerMeasurement.activeCurrent, 45);
        assert.equal(state.bridgedDeviceBasicInformation.nodeLabel, "Hue Wohnzimmer");
        assert.equal(state.bridgedDeviceBasicInformation.reachable, true);
    });

    it("liefert die Geraeteliste fuer die API", () => {
        const devices = manager.devices;
        assert.equal(devices.length, 4);

        const byName = Object.fromEntries(devices.map(entry => [entry.name, entry]));
        assert.equal(byName.Stehlampe.watts, 10);
        assert.equal(byName.Stehlampe.room, "Wohnzimmer");
        assert.equal(byName.Stehlampe.meterId, "hue-wohnzimmer");
        assert.equal(byName.Stehlampe.state, "an");
        assert.equal(byName.Deckenlampe.state, "aus");
        assert.equal(byName.Flurlampe.state, "stromlos");
        assert.equal(byName.Kuechenlampe.model, "Hue White Ambiance E27");

        assert.equal(manager.status.hue.connected, true);
        assert.equal(manager.status.hue.lights, 4);
        assert.equal(manager.status.hue.rooms, 3);
        assert.equal(manager.status.hue.bridgeName, "Testbridge");
        assert.equal(manager.status.hue.apiVersion, 2);
    });

    it("merkt sich die Zaehler fuer den naechsten Start", async () => {
        const stored = JSON.parse(await readFile(join(storagePath, "source-meters.json"), "utf8"));
        assert.deepEqual(
            stored.meters.map(entry => entry.id).sort(),
            ["hue-bridge", "hue-kueche", "hue-ohne-raum", "hue-wohnzimmer"],
        );
        assert.equal(stored.meters.find(entry => entry.id === "hue-wohnzimmer").room, "Wohnzimmer");
    });
});

describe("Ein Zaehler laesst sich nicht anlegen", () => {
    it("aktualisiert die uebrigen Raeume trotzdem und versucht es nicht endlos erneut", async () => {
        const attempts = [];
        // Bridge-Attrappe: verhaelt sich wie die echte, verweigert aber genau
        // einen Zaehler - so wie Matter es bei einer zu langen Seriennummer tat.
        const failing = {
            meters: new Map([...bridge.meters].filter(([id]) => id !== "hue-kueche")),
            addMeter: async meterConfig => {
                attempts.push(meterConfig.id);
                if (meterConfig.id === "hue-kueche") throw new Error("Anlegen verweigert (Test)");
                return bridge.addMeter(meterConfig);
            },
        };

        const storage = await mkdtemp(join(tmpdir(), "vpm-broken-"));
        const { SourceManager } = await import("../dist/sources/manager.js");
        // Kurzes Intervall, damit im Test eine zweite Runde laeuft.
        const quick = { ...config, storagePath: storage, sources: { ...config.sources, hue: { ...config.sources.hue, intervalSeconds: 1 } } };
        const manager2 = new SourceManager(quick, failing);

        try {
            await manager2.prepare();
            await manager2.start();

            // Der kaputte Raum fehlt, alle anderen tragen Werte.
            assert.equal(failing.meters.has("hue-kueche"), false);
            assert.equal(failing.meters.get("hue-wohnzimmer").snapshot.power, 10.4);
            assert.equal(failing.meters.get("hue-ohne-raum").snapshot.power, 0);
            assert.equal(
                failing.meters.get("hue-bridge").snapshot.power,
                1.9,
                "die Bridge-Grundlast kommt nach den Raeumen - sie beweist, dass die Runde nicht abgebrochen ist",
            );
            assert.equal(manager2.devices.length, 4, "die Geraeteliste bleibt vollstaendig");

            // Zweite Runde abwarten: der kaputte Zaehler wird nicht noch einmal versucht.
            await new Promise(resolve => setTimeout(resolve, 1300));
            assert.equal(
                attempts.filter(id => id === "hue-kueche").length,
                1,
                `hue-kueche wurde ${attempts.filter(id => id === "hue-kueche").length}x versucht, erwartet: genau 1`,
            );
            assert.ok(attempts.length >= 1);
        } finally {
            await manager2.stop();
            await rm(storage, { recursive: true, force: true });
        }
    });
});

describe("Hue-Bridge faellt aus", () => {
    it("meldet die Zaehler als nicht erreichbar und laesst den letzten Wert stehen", async () => {
        const before = bridge.meters.get("hue-wohnzimmer").snapshot.power;
        assert.equal(before, 10.4);

        await manager.stop();
        await new Promise(resolve => server.close(resolve));

        // Ein frischer Manager auf demselben Knoten: er stellt die bekannten
        // Zaehler aus der Liste wieder her und findet die Bridge nicht mehr.
        const { SourceManager } = await import("../dist/sources/manager.js");
        const restarted = new SourceManager(config, bridge);
        await restarted.prepare();
        await restarted.start();

        try {
            for (const id of ["hue-wohnzimmer", "hue-kueche", "hue-bridge"]) {
                const meter = bridge.meters.get(id);
                assert.equal(meter.snapshot.reachable, false, `${id} muss als nicht erreichbar gelten`);
                assert.equal(
                    endpointOf(id).state.bridgedDeviceBasicInformation.reachable,
                    false,
                    `${id}: Matter-Attribut nachgezogen`,
                );
            }

            assert.equal(
                bridge.meters.get("hue-wohnzimmer").snapshot.power,
                before,
                "der letzte bekannte Wert bleibt stehen, statt auf 0 zu springen",
            );
            assert.equal(restarted.status.hue.connected, false);
            assert.ok(restarted.status.hue.error, "der Fehler steht in der Statusausgabe");
        } finally {
            await restarted.stop();
        }
    });

    it("legt nach einem Neustart keine doppelten Zaehler an", () => {
        assert.deepEqual(
            [...bridge.meters.keys()].sort(),
            ["hue-bridge", "hue-kueche", "hue-ohne-raum", "hue-wohnzimmer"],
        );
    });
});
