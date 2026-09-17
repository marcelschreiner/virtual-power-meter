/**
 * Laengengrenzen der Matter-Spezifikation.
 *
 * Ein Zaehler entsteht aus einem Raumnamen, und Raumnamen koennen lang sein.
 * BridgedDeviceBasicInformation begrenzt serialNumber und nodeLabel auf 32
 * Zeichen - wird das gerissen, scheitert das Anlegen des Endpoints mitten im
 * Betrieb. Genau das ist auf dem NAS passiert:
 *   "vpm-0001-sonos-wohnzimmer-oben-rechts" = 37 Zeichen.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { NetworkSimulator } from "@matter/general";
import { Environment, Network } from "@matter/main";

const MAX_SERIAL_NUMBER = 32;
const MAX_NODE_LABEL = 32;

let bridge;
let storagePath;

function meter(id, name) {
    return {
        id,
        name,
        kind: "meter",
        nominalVoltage: 230,
        phases: 1,
        initialEnergyImportedKwh: 0,
        initialEnergyExportedKwh: 0,
        simulation: { enabled: false, minWatts: 0, maxWatts: 0, intervalSeconds: 10 },
    };
}

before(async () => {
    Environment.default.set(Network, new NetworkSimulator().addHost(1));
    storagePath = await mkdtemp(join(tmpdir(), "vpm-limits-"));

    const { createBridge } = await import("../dist/matter/bridge.js");
    const { EnergyStore } = await import("../dist/persistence.js");
    const store = new EnergyStore(storagePath);
    await store.load();

    bridge = await createBridge(
        {
            bridge: {
                name: "Testbridge",
                vendorName: "Test",
                vendorId: 0xfff1,
                productName: "Test",
                productId: 0x8001,
                serialNumber: "vpm-0001",
                passcode: 20202021,
                discriminator: 3456,
                port: 5562,
            },
            api: { enabled: false, host: "127.0.0.1", port: 0 },
            meters: [],
            storagePath,
            integrationIntervalSeconds: 10,
        },
        store,
    );
    await bridge.node.start();
});

after(async () => {
    await bridge?.node.close();
    await rm(storagePath, { recursive: true, force: true });
});

function infoOf(id) {
    return bridge.node.parts.get("meters").parts.get(id).state.bridgedDeviceBasicInformation;
}

describe("Laengengrenzen der Bridged Devices", () => {
    it("legt einen Zaehler mit langer ID an, statt daran zu scheitern", async () => {
        // Der Fall aus dem Betrieb: 8 + 1 + 28 = 37 Zeichen waeren es ungekuerzt.
        await bridge.addMeter(meter("sonos-wohnzimmer-oben-rechts", "Sonos Wohnzimmer oben rechts"));

        const info = infoOf("sonos-wohnzimmer-oben-rechts");
        assert.ok(
            info.serialNumber.length <= MAX_SERIAL_NUMBER,
            `serialNumber zu lang: ${info.serialNumber} (${info.serialNumber.length})`,
        );
        assert.match(info.serialNumber, /^vpm-0001-/, "der Anfang bleibt lesbar");
        assert.equal(info.nodeLabel, "Sonos Wohnzimmer oben rechts");
    });

    it("laesst kurze Namen unveraendert", async () => {
        await bridge.addMeter(meter("hue-wohnzimmer", "Hue Wohnzimmer"));
        // Vorhandene Geraete duerfen ihre Identitaet nicht wechseln.
        assert.equal(infoOf("hue-wohnzimmer").serialNumber, "vpm-0001-hue-wohnzimmer");
    });

    it("haelt lange IDs mit gleichem Anfang auseinander", async () => {
        await bridge.addMeter(meter("sonos-wohnzimmer-oben-recht", "A"));
        await bridge.addMeter(meter("sonos-wohnzimmer-oben-rech2", "B"));

        const first = infoOf("sonos-wohnzimmer-oben-recht").serialNumber;
        const second = infoOf("sonos-wohnzimmer-oben-rech2").serialNumber;
        assert.notEqual(first, second, "zwei Zaehler duerfen nie dieselbe Seriennummer tragen");
        assert.ok(first.length <= MAX_SERIAL_NUMBER && second.length <= MAX_SERIAL_NUMBER);
    });

    it("kuerzt einen zu langen Anzeigenamen", async () => {
        const long = "Sonos Wohnzimmer hinten links am Fenster";
        assert.ok(long.length > MAX_NODE_LABEL, "der Testname muss die Grenze reissen");

        await bridge.addMeter(meter("sonos-langer-name", long));
        const info = infoOf("sonos-langer-name");
        assert.equal(info.nodeLabel.length, MAX_NODE_LABEL);
        assert.ok(long.startsWith(info.nodeLabel), "gekuerzt wird hinten, der Anfang bleibt erkennbar");
        // productLabel darf 64 Zeichen tragen - dort passt der volle Name.
        assert.equal(info.productLabel, long);
    });

    it("bleibt ueber Neustarts stabil", async () => {
        // Dieselbe ID muss immer dieselbe Seriennummer ergeben, sonst ist es fuer
        // den Controller jedes Mal ein neues Geraet.
        const before = infoOf("sonos-wohnzimmer-oben-rechts").serialNumber;
        const again = await bridge.addMeter(meter("sonos-wohnzimmer-oben-rechts", "Sonos Wohnzimmer oben rechts"));
        assert.equal(again.id, "sonos-wohnzimmer-oben-rechts");
        assert.equal(infoOf("sonos-wohnzimmer-oben-rechts").serialNumber, before);
    });
});
