/**
 * Der neue Teil gegenueber der Python-Fassung: aus einzelnen Geraeten werden
 * Summen je Raum, und daraus je ein Zaehler. Hier wird genau dieser Schritt
 * geprueft - ohne Matter, ohne Netzwerk.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { aggregateLamps, aggregateSpeakers, shortModel, speakerState, UNASSIGNED_ROOM } from "../dist/sources/aggregate.js";
import { LampCatalog, SpeakerCatalog } from "../dist/sources/catalog.js";

const lampCatalog = await LampCatalog.load();
const speakerCatalog = await SpeakerCatalog.load({}, "230");

/** Zaehler-ID wie im Betrieb: "hue-<raum>". */
const idFor = room => `hue-${room.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

function lamp(overrides = {}) {
    return {
        id: "l1",
        name: "Lampe",
        modelId: "LCT015",
        productName: "",
        archetype: "",
        room: "Wohnzimmer",
        capability: "color",
        on: false,
        brightness: 1,
        mode: "none",
        gradientXy: [],
        reachable: true,
        ...overrides,
    };
}

function speaker(overrides = {}) {
    return {
        id: "RINCON_1",
        name: "Wohnzimmer",
        room: "Wohnzimmer",
        model: "Sonos One",
        modelNumber: "S13",
        ip: "10.0.0.5",
        playing: false,
        muted: false,
        volume: 0,
        transport: "STOPPED",
        reachable: true,
        wired: false,
        usbAdapter: false,
        ...overrides,
    };
}

describe("Lampen zu Raumsummen", () => {
    it("summiert je Raum und legt Lampen ohne Raum zusammen", () => {
        const lights = [
            lamp({ id: "a", room: "Wohnzimmer" }), // aus: 0.4 W
            lamp({ id: "b", room: "Wohnzimmer" }), // aus: 0.4 W
            lamp({ id: "c", room: "Kueche", on: true }), // an, voll: 10 W
            lamp({ id: "d", room: "" }), // ohne Raum, aus: 0.4 W
        ];

        const { totals, reports } = aggregateLamps(lights, lampCatalog, 2, idFor);

        assert.deepEqual([...totals.keys()].sort(), ["Kueche", "Ohne Raum", "Wohnzimmer"]);
        assert.equal(round(totals.get("Wohnzimmer").watts), 0.8, "zwei ausgeschaltete Farblampen: 2 x 0.4 W");
        assert.equal(round(totals.get("Kueche").watts), 10, "eine Lampe auf voller Helligkeit");
        assert.equal(round(totals.get(UNASSIGNED_ROOM).watts), 0.4);
        assert.equal(reports.length, 4);
        assert.equal(reports[0].meterId, "hue-wohnzimmer");
        assert.equal(reports.find(r => r.id === "d").room, UNASSIGNED_ROOM);
    });

    it("meldet einen Raum als erreichbar, sobald eine Lampe antwortet", () => {
        const mixed = aggregateLamps(
            [lamp({ id: "a", reachable: false }), lamp({ id: "b", reachable: true })],
            lampCatalog,
            2,
            idFor,
        );
        assert.equal(mixed.totals.get("Wohnzimmer").reachable, true);

        const dark = aggregateLamps(
            [lamp({ id: "a", reachable: false }), lamp({ id: "b", reachable: false })],
            lampCatalog,
            2,
            idFor,
        );
        assert.equal(dark.totals.get("Wohnzimmer").reachable, false, "stromloser Raum gilt als nicht erreichbar");
        assert.equal(dark.totals.get("Wohnzimmer").watts, 0, "stromlose Lampen ziehen nichts");
    });

    it("beschreibt den Zustand jeder Lampe fuer die API", () => {
        const { reports } = aggregateLamps(
            [
                lamp({ id: "a", on: true, brightness: 0.5, room: "Bad" }),
                lamp({ id: "b", on: false, room: "Bad" }),
                lamp({ id: "c", reachable: false, room: "Bad" }),
            ],
            lampCatalog,
            2,
            idFor,
        );

        const byId = Object.fromEntries(reports.map(entry => [entry.id, entry]));
        assert.equal(byId.a.state, "an");
        assert.equal(byId.a.active, true);
        assert.equal(byId.a.level, 0.5);
        assert.equal(byId.a.model, "Hue Color A19/A60 (Gen 3)");
        assert.equal(byId.a.estimate, false, "LCT015 steht exakt in der Datenbank");
        assert.equal(byId.b.state, "aus");
        assert.equal(byId.c.state, "stromlos");
        assert.equal(byId.c.active, false);
    });

    it("markiert abgeleitete Modelldaten als Schaetzung", () => {
        const { reports } = aggregateLamps([lamp({ modelId: "LCT999" })], lampCatalog, 2, idFor);
        assert.equal(reports[0].estimate, true);
        assert.equal(reports[0].match, "family");
    });
});

describe("Lautsprecher zu Zonensummen", () => {
    it("fasst ein Stereopaar zu einer Zone zusammen und benennt die Geraete eindeutig", () => {
        const pair = [
            speaker({ id: "RINCON_A", model: "Sonos One" }),
            speaker({ id: "RINCON_B", model: "Sonos One" }),
        ];

        const { totals, reports } = aggregateSpeakers(pair, speakerCatalog, 0.5, room => `sonos-${room}`);

        assert.equal(totals.size, 1, "beide Boxen gehoeren zur Zone Wohnzimmer");
        assert.equal(round(totals.get("Wohnzimmer").watts), 6.8, "zwei One im Leerlauf: 2 x 3.4 W");
        assert.deepEqual(
            reports.map(entry => entry.name).sort(),
            ["Wohnzimmer · One 1", "Wohnzimmer · One 2"],
            "gleiches Modell wird durchnummeriert",
        );
        assert.equal(reports[0].meterId, "sonos-Wohnzimmer");
    });

    it("ergaenzt bei gemischten Modellen das Modell statt einer Nummer", () => {
        const home = [
            speaker({ id: "RINCON_A", model: "Sonos Beam (Gen 2)" }),
            speaker({ id: "RINCON_B", model: "Sonos One" }),
        ];
        const { reports } = aggregateSpeakers(home, speakerCatalog, 0.5, room => `sonos-${room}`);
        assert.deepEqual(reports.map(entry => entry.name).sort(), ["Wohnzimmer · Beam (Gen 2)", "Wohnzimmer · One"]);
    });

    it("rechnet den USB-Netzwerkadapter nur beim Era am Kabel dazu", () => {
        const era = speaker({ model: "Sonos Era 100", wired: true });
        const { totals, reports } = aggregateSpeakers([era], speakerCatalog, 0.5, room => `sonos-${room}`);
        // Era 100 Leerlauf bei 230 V: 1.86 W, plus 0.5 W Adapter.
        assert.equal(round(totals.get("Wohnzimmer").watts), 2.36);
        assert.equal(reports[0].link, "usb");
        assert.equal(reports[0].estimate, true, "der Adapteraufschlag ist geschaetzt");

        const wireless = aggregateSpeakers([speaker({ model: "Sonos Era 100" })], speakerCatalog, 0.5, r => r);
        assert.equal(round(wireless.totals.get("Wohnzimmer").watts), 1.86);
        assert.equal(wireless.reports[0].link, "wireless");

        // Eine One hat einen eigenen Netzwerkanschluss - da kommt nichts dazu.
        const one = aggregateSpeakers([speaker({ model: "Sonos One", wired: true })], speakerCatalog, 0.5, r => r);
        assert.equal(round(one.totals.get("Wohnzimmer").watts), 3.4);
        assert.equal(one.reports[0].link, "wired");
    });

    it("trennt verschiedene Zonen", () => {
        const { totals } = aggregateSpeakers(
            [
                speaker({ id: "A", room: "Wohnzimmer" }),
                speaker({ id: "B", room: "Kueche" }),
                speaker({ id: "C", room: "Kueche" }),
            ],
            speakerCatalog,
            0.5,
            room => `sonos-${room}`,
        );
        assert.deepEqual([...totals.keys()].sort(), ["Kueche", "Wohnzimmer"]);
        assert.equal(round(totals.get("Kueche").watts), 6.8);
    });

    it("beschreibt den Zustand eines Players", () => {
        assert.equal(speakerState(speaker({ playing: true })), "spielt");
        assert.equal(speakerState(speaker({ transport: "PAUSED_PLAYBACK" })), "pausiert");
        assert.equal(speakerState(speaker({ transport: "STOPPED" })), "gestoppt");
        assert.equal(speakerState(speaker({ transport: "IRGENDWAS" })), "bereit");
        assert.equal(speakerState(speaker({ playing: true, muted: true })), "stumm");
        assert.equal(speakerState(speaker({ reachable: false })), "nicht erreichbar");
    });

    it("kuerzt Modellnamen", () => {
        assert.equal(shortModel("Sonos Beam (Gen 2)"), "Beam (Gen 2)");
        assert.equal(shortModel("IKEA SYMFONISK Bookshelf"), "SYMFONISK Bookshelf");
        assert.equal(shortModel(""), "Box");
    });
});

function round(value) {
    return Math.round(value * 1000) / 1000;
}
