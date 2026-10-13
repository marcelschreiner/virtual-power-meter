/**
 * Shelly misst selbst - getestet wird, dass beide API-Familien richtig gelesen
 * und mehrkanalige Geraete sinnvoll zusammengefasst werden. Die Antworten sind
 * auf die Felder gekuerzt, die tatsaechlich gelesen werden.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { ShellyDevice } from "../dist/sources/shelly.js";

const servers = [];

/** Ein nachgebauter Shelly: `routes` bildet Pfad -> JSON-Antwort ab. */
async function fakeShelly(routes, status = 200) {
    const server = createServer((request, response) => {
        const body = routes[request.url];
        if (body === undefined || status !== 200) {
            response.writeHead(body === undefined ? 404 : status);
            return response.end();
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    return `127.0.0.1:${server.address().port}`;
}

after(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
});

describe("Shelly ablesen", () => {
    it("Gen1 Plug S: meters[] plus Geraetespannung", async () => {
        const ip = await fakeShelly({
            "/shelly": { type: "SHPLG-S", mac: "AABBCCDDEEFF" },
            "/status": { meters: [{ power: 42.5, is_valid: true, total: 1234 }], voltage: 231.2 },
        });
        const device = new ShellyDevice(ip);
        const reading = await device.poll();

        assert.equal(device.generation, 1);
        assert.equal(device.model, "SHPLG-S");
        assert.equal(reading.power, 42.5);
        assert.equal(reading.voltage, 231.2);
        assert.equal(reading.channels, 1);
    });

    it("Gen1 3EM: drei emeters werden summiert, Strom bleibt offen", async () => {
        const ip = await fakeShelly({
            "/shelly": { type: "SHEM-3" },
            "/status": {
                emeters: [
                    { power: 100, voltage: 230, current: 0.5, is_valid: true },
                    { power: 200, voltage: 232, current: 0.9, is_valid: true },
                    { power: -50, voltage: 234, current: 0.3, is_valid: true },
                ],
            },
        });
        const reading = await new ShellyDevice(ip).poll();

        assert.equal(reading.power, 250);
        assert.equal(reading.voltage, 232);
        assert.equal(reading.current, undefined, "Summe ueber Phasen waere sinnlos");
        assert.equal(reading.channels, 3);
    });

    it("Gen2+ Plus Plug S: switch:0 mit Leistung, Spannung und Strom", async () => {
        const ip = await fakeShelly({
            "/shelly": { gen: 2, model: "SNPL-00112EU", name: "Kaffeemaschine" },
            "/rpc/Shelly.GetStatus": {
                sys: { uptime: 100 },
                wifi: { rssi: -60 },
                "switch:0": { id: 0, output: true, apower: 1180.4, voltage: 229.8, current: 5.14 },
            },
        });
        const device = new ShellyDevice(ip);
        const reading = await device.poll();

        assert.equal(device.generation, 2);
        assert.equal(device.name, "Kaffeemaschine");
        assert.deepEqual(reading, { power: 1180.4, voltage: 229.8, current: 5.14, channels: 1 });
    });

    it("Gen3 erkennt sich ebenfalls als RPC-Geraet", async () => {
        const ip = await fakeShelly({
            "/shelly": { gen: 3, model: "S3PM-001PCEU16" },
            "/rpc/Shelly.GetStatus": { "switch:0": { apower: 12, voltage: 230, current: 0.08 } },
        });
        const device = new ShellyDevice(ip);
        await device.poll();
        assert.equal(device.generation, 2);
    });

    it("Pro 3EM: em:0 liefert die Summe der Phasen", async () => {
        const ip = await fakeShelly({
            "/shelly": { gen: 2, model: "SPEM-003CEBEU" },
            "/rpc/Shelly.GetStatus": {
                "em:0": { total_act_power: -1523.7, a_voltage: 231, b_voltage: 233, c_voltage: 232 },
                "emdata:0": { total_act: 123456 },
            },
        });
        const reading = await new ShellyDevice(ip).poll();

        assert.equal(reading.power, -1523.7, "Einspeisung bleibt negativ");
        assert.equal(reading.voltage, 232);
        assert.equal(reading.current, undefined);
    });

    it("Plus 2PM: zwei Kanaele werden summiert", async () => {
        const ip = await fakeShelly({
            "/shelly": { gen: 2, model: "SNSW-102P16EU" },
            "/rpc/Shelly.GetStatus": {
                "switch:0": { apower: 60, voltage: 230, current: 0.3 },
                "switch:1": { apower: 40, voltage: 230, current: 0.2 },
            },
        });
        const reading = await new ShellyDevice(ip).poll();
        assert.equal(reading.power, 100);
        assert.equal(reading.channels, 2);
    });

    it("Shelly ohne Strommessung meldet einen verstaendlichen Fehler", async () => {
        const ip = await fakeShelly({
            "/shelly": { gen: 2, model: "SNSW-001X16EU" },
            "/rpc/Shelly.GetStatus": { "switch:0": { output: true } },
        });
        await assert.rejects(new ShellyDevice(ip).poll(), /keine Leistung/);
    });

    it("Passwortschutz wird als solcher gemeldet", async () => {
        const ip = await fakeShelly({ "/shelly": {} }, 401);
        await assert.rejects(new ShellyDevice(ip).poll(), /Passwort/);
    });

    it("nicht erreichbar wird als Fehler gemeldet", async () => {
        await assert.rejects(new ShellyDevice("127.0.0.1:1").poll(), /nicht erreichbar/);
    });
});

describe("Shelly-Konfiguration", () => {
    async function load(fileContent, env = {}) {
        const dir = await mkdtemp(join(tmpdir(), "vpm-shelly-"));
        const path = join(dir, "meters.json");
        await writeFile(path, JSON.stringify(fileContent), "utf8");
        const saved = { ...process.env };
        Object.assign(process.env, { VPM_CONFIG: path, ...env });
        try {
            const { loadConfig } = await import("../dist/config.js");
            return await loadConfig();
        } finally {
            process.env = saved;
            await rm(dir, { recursive: true, force: true });
        }
    }

    it("eine IP genuegt - ID und Name entstehen aus der Adresse", async () => {
        const config = await load({ sources: { shelly: { devices: ["192.168.1.50"] } } });
        const { shelly } = config.sources;

        assert.equal(shelly.enabled, true);
        assert.deepEqual(shelly.devices, [
            { ip: "192.168.1.50", id: "shelly-192-168-1-50", name: "Shelly 192.168.1.50", kind: "meter", phases: 1 },
        ]);
        assert.equal(config.meters.length, 0, "kein Beispielzaehler, wenn eine Quelle aktiv ist");
    });

    it("VPM_SHELLY_IPS ersetzt die Liste aus der Datei", async () => {
        const config = await load({}, { VPM_SHELLY_IPS: "10.0.0.7, 10.0.0.8" });
        assert.deepEqual(
            config.sources.shelly.devices.map(device => device.id),
            ["shelly-10-0-0-7", "shelly-10-0-0-8"],
        );
    });

    it("ID-Kollision mit einem Hand-Zaehler wird abgelehnt", async () => {
        await assert.rejects(
            load({
                meters: [{ id: "waschmaschine" }],
                sources: { shelly: { devices: [{ ip: "10.0.0.9", id: "waschmaschine" }] } },
            }),
            /Doppelte Zaehler-ID/,
        );
    });

    it("ohne Adressen bleibt die Quelle aus", async () => {
        const config = await load({ sources: { shelly: { enabled: true, devices: [] } } });
        assert.equal(config.sources.shelly.enabled, false);
    });
});
