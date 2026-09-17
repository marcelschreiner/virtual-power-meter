/**
 * Sonos fuehrt die Wiedergabe pro Gruppe, nicht pro Geraet.
 *
 * Fragt man jeden Lautsprecher ueber sich selbst, antwortet ein Stereopaar-
 * Partner mit dem Zustand von vorhin - im Betrieb hiess das: pausierte Boxen
 * wurden als spielend abgerechnet. Die Testdaten unter `fixtures/sonos/` sind
 * echte Antworten genau dieser Anlage, inklusive des Widerspruchs:
 * der Koordinator meldet PAUSED_PLAYBACK, sein Partner PLAYING.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { readZoneGroups, SonosSystem } from "../dist/sources/sonos.js";

// Die Kennungen und Raumnamen im Testdatensatz sind ersetzt; die Struktur der
// Antwort ist unveraendert die einer echten Anlage.
const COORDINATOR = "RINCON_000000000001400"; // Arbeitszimmer, pausiert
const PARTNER = "RINCON_000000000002400"; // Arbeitszimmer, meldet veraltet PLAYING
const GROUPED = "RINCON_000000000004400"; // Wohnzimmer, derselben Gruppe zugeschaltet
const ALONE = "RINCON_000000000005400"; // Kueche, eigene Gruppe

const fixture = name => readFile(new URL(`./fixtures/sonos/${name}`, import.meta.url), "utf8");

let topology;
let transportPaused;
let transportPlaying;
let volume;
const servers = [];

/** Ein nachgebauter Player. `transport` ist, was er ueber SICH SELBST sagt. */
async function fakeSpeaker({ uuid, room, model, transport, topologyStatus = 200 }) {
    const server = createServer((request, response) => {
        const send = (body, status = 200) => {
            response.writeHead(status, { "content-type": "text/xml" });
            response.end(body);
        };
        if (request.url === "/xml/device_description.xml") {
            return send(
                `<?xml version="1.0"?><root><device><roomName>${room}</roomName>` +
                    `<modelName>${model}</modelName><modelNumber>S13</modelNumber>` +
                    `<UDN>uuid:${uuid}</UDN></device></root>`,
            );
        }
        if (request.url === "/status/ifconfig") return send("", 404);
        if (request.url === "/ZoneGroupTopology/Control") {
            return topologyStatus === 200 ? send(topology) : send("", topologyStatus);
        }
        if (request.url === "/MediaRenderer/AVTransport/Control") {
            return send(transport === "PLAYING" ? transportPlaying : transportPaused);
        }
        if (request.url === "/MediaRenderer/RenderingControl/Control") return send(volume);
        send("", 404);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    return `127.0.0.1:${server.address().port}`;
}

before(async () => {
    [topology, transportPaused, transportPlaying, volume] = await Promise.all([
        fixture("zone-group-state.xml"),
        fixture("transport-paused.xml"),
        fixture("transport-stale-playing.xml"),
        fixture("volume.xml"),
    ]);
});

after(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
});

describe("Gruppenstruktur lesen", () => {
    it("versteht die echte Antwort einer Anlage", async () => {
        const ip = await fakeSpeaker({ uuid: COORDINATOR, room: "Arbeitszimmer", model: "Sonos Era 100", transport: "PAUSED" });
        const groups = await readZoneGroups(ip);

        assert.equal(groups.length, 2, "zwei Gruppen");
        const big = groups.find(group => group.coordinator === COORDINATOR);
        assert.ok(big, "die Gruppe mit Arbeitszimmer als Koordinator");
        assert.equal(big.members.length, 4, "Stereopaar plus zugeschaltetes Paar");
        for (const uuid of [COORDINATOR, PARTNER, GROUPED]) {
            assert.ok(big.members.includes(uuid), `${uuid} gehoert zur Gruppe`);
        }
        assert.deepEqual(groups.find(group => group.coordinator === ALONE)?.members, [ALONE]);
    });

    it("gibt eine leere Liste zurueck, wenn der Player nicht antwortet", async () => {
        assert.deepEqual(await readZoneGroups("127.0.0.1:1"), []);
    });
});

describe("Wiedergabezustand einer Gruppe", () => {
    it("uebernimmt den Zustand des Koordinators fuer alle Mitglieder", async () => {
        const ips = await Promise.all([
            fakeSpeaker({ uuid: COORDINATOR, room: "Arbeitszimmer", model: "Sonos Era 100", transport: "PAUSED" }),
            // Der Partner behauptet ueber sich selbst, er spiele - das ist der Fehlerfall.
            fakeSpeaker({ uuid: PARTNER, room: "Arbeitszimmer", model: "Sonos Era 100", transport: "PLAYING" }),
            fakeSpeaker({ uuid: GROUPED, room: "Wohnzimmer", model: "Sonos One", transport: "PLAYING" }),
            fakeSpeaker({ uuid: ALONE, room: "Kueche", model: "Sonos One", transport: "PAUSED" }),
        ]);

        const system = new SonosSystem(ips, 0);
        assert.equal(await system.start(), 4);

        const speakers = await system.poll();
        assert.equal(system.groupCount, 2, "die Gruppenstruktur wurde gelesen");

        const byId = Object.fromEntries(speakers.map(speaker => [speaker.id, speaker]));
        for (const uuid of [COORDINATOR, PARTNER, GROUPED]) {
            assert.equal(byId[uuid].playing, false, `${uuid} darf nicht als spielend gelten`);
            assert.equal(byId[uuid].transport, "PAUSED_PLAYBACK", `${uuid} uebernimmt den Zustand des Koordinators`);
        }
        assert.equal(byId[ALONE].playing, false);
        // Die Lautstaerke kommt weiterhin von jedem Geraet selbst.
        assert.equal(byId[PARTNER].volume, 0.25);
        assert.equal(byId[PARTNER].reachable, true);
    });

    it("faellt auf die Auskunft der einzelnen Geraete zurueck, wenn die Struktur fehlt", async () => {
        const ips = await Promise.all([
            fakeSpeaker({ uuid: COORDINATOR, room: "Arbeitszimmer", model: "Sonos Era 100", transport: "PAUSED", topologyStatus: 500 }),
            fakeSpeaker({ uuid: PARTNER, room: "Arbeitszimmer", model: "Sonos Era 100", transport: "PLAYING", topologyStatus: 500 }),
        ]);

        const system = new SonosSystem(ips, 0);
        await system.start();
        const speakers = await system.poll();

        assert.equal(system.groupCount, 0, "keine Gruppen gelesen");
        const byId = Object.fromEntries(speakers.map(speaker => [speaker.id, speaker]));
        // Ungenau, aber besser als gar keine Werte - und es ist dokumentiert.
        assert.equal(byId[COORDINATOR].playing, false);
        assert.equal(byId[PARTNER].playing, true);
    });

    it("meldet einen stummen Player nicht als spielend", async () => {
        const ips = [await fakeSpeaker({ uuid: ALONE, room: "Kueche", model: "Sonos One", transport: "PAUSED" })];
        const system = new SonosSystem(ips, 0);
        await system.start();
        const [speaker] = await system.poll();
        assert.equal(speaker.muted, false, "25 % Lautstaerke sind nicht stumm");
        assert.equal(speaker.playing, false);
    });
});
