/**
 * Prueft den Port des Schaetzmodells gegen die Python-Fassung.
 *
 * Die Referenzwerte in `fixtures/python-reference.json` stammen aus dem
 * Originalprogramm (hue_energy). Weicht der Port ab, faellt das hier auf -
 * das ist der eigentliche Zweck dieser Datei.
 *
 * Braucht weder Matter noch Netzwerk: Modell, Katalog und Namensbildung sind
 * reine Rechnerei.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { LampCatalog, SpeakerCatalog, normaliseModel } from "../dist/sources/catalog.js";
import { estimateLamp, estimateSpeaker, colorFactor, whiteness } from "../dist/sources/model.js";
import { meterIdFor, slug } from "../dist/sources/naming.js";

const reference = JSON.parse(await readFile(new URL("./fixtures/python-reference.json", import.meta.url), "utf8"));

/** Gleitkommazahlen duerfen sich im Rahmen der Rechengenauigkeit unterscheiden. */
function assertClose(actual, expected, message) {
    assert.ok(
        Math.abs(actual - expected) < 1e-9,
        `${message}: ${actual} statt ${expected} (Abweichung ${Math.abs(actual - expected)})`,
    );
}

describe("Schaetzmodell fuer Lampen", () => {
    it("liefert fuer jeden Referenzfall dieselben Watt wie die Python-Fassung", async () => {
        const catalog = await LampCatalog.load();

        for (const testCase of reference.lamps) {
            const light = {
                ...testCase.light,
                xy: testCase.light.xy ?? undefined,
                gradientXy: testCase.light.gradientXy,
            };
            const spec = catalog.lookup(light);

            assertClose(spec.maxW, testCase.spec.maxW, `${testCase.label}: maxW`);
            assertClose(spec.standbyW, testCase.spec.standbyW, `${testCase.label}: standbyW`);
            assert.equal(spec.match, testCase.spec.match, `${testCase.label}: Trefferart`);
            assert.equal(spec.kind, testCase.spec.kind, `${testCase.label}: Art`);
            assert.equal(spec.isEstimate, testCase.spec.isEstimate, `${testCase.label}: Schaetzmarkierung`);

            const estimate = estimateLamp(light, spec);
            assertClose(estimate.watts, testCase.estimate.watts, `${testCase.label}: Leistung`);
            assertClose(estimate.standbyW, testCase.estimate.standbyW, `${testCase.label}: Grundlast`);
            assertClose(estimate.colorFactor, testCase.estimate.colorFactor, `${testCase.label}: Farbfaktor`);
            assertClose(colorFactor(light), testCase.colorFactor, `${testCase.label}: colorFactor()`);
        }
    });

    it("haelt die im README dokumentierten Farbanteile ein", () => {
        // Jeder Weisston zwischen 2000 K und 6500 K zieht die volle Leistung.
        for (const [x, y] of [
            [0.5269, 0.4133], // 2000 K
            [0.4573, 0.41], // 2700 K
            [0.3805, 0.3768], // 4000 K
            [0.3135, 0.3236], // 6500 K
        ]) {
            assert.equal(whiteness(x, y), 1, `Weisston ${x}/${y} muss als Weiss gelten`);
            assert.equal(colorFactor({ mode: "xy", xy: [x, y], on: true, brightness: 1, reachable: true }), 1);
        }

        const factorOf = (x, y) => colorFactor({ mode: "xy", xy: [x, y], on: true, brightness: 1, reachable: true });
        const magenta = factorOf(0.38, 0.16);
        const deepBlue = factorOf(0.15, 0.06);
        const red = factorOf(0.675, 0.322);
        const green = factorOf(0.17, 0.7);

        assert.ok(magenta > 0.6 && magenta < 0.7, `Magenta (zwei Kanaele) erwartet 60-70 %, war ${magenta}`);
        for (const [name, value] of [
            ["Tiefblau", deepBlue],
            ["Rot", red],
            ["Gruen", green],
        ]) {
            assert.ok(value > 0.3 && value < 0.4, `${name} erwartet 30-40 %, war ${value}`);
        }
    });

    it("rechnet die Helligkeit quadratisch, mit Vorschaltgeraet als Sockel", () => {
        const spec = { maxW: 10, standbyW: 0.4, gamma: 2, kind: "color", label: "", source: "", match: "exact", isEstimate: false };
        const light = { reachable: true, on: true, brightness: 1, mode: "none" };

        assertClose(estimateLamp(light, spec).watts, 10, "voll");
        // 0.4 + 0.25 + (10 - 0.4 - 0.25) * 0.25 = 2.99
        assertClose(estimateLamp({ ...light, brightness: 0.5 }, spec).watts, 2.9875, "halb");
        // Auch bei 0 % laeuft das Vorschaltgeraet mit.
        assertClose(estimateLamp({ ...light, brightness: 0 }, spec).watts, 0.65, "ganz dunkel");
        assertClose(estimateLamp({ ...light, on: false }, spec).watts, 0.4, "aus");
        assertClose(estimateLamp({ ...light, reachable: false }, spec).watts, 0, "stromlos");
    });
});

describe("Schaetzmodell fuer Lautsprecher", () => {
    it("liefert fuer jeden Referenzfall dieselben Watt wie die Python-Fassung", async () => {
        const catalogs = {
            230: await SpeakerCatalog.load({}, "230"),
            120: await SpeakerCatalog.load({}, "120"),
        };

        for (const testCase of reference.speakers) {
            const catalog = catalogs[testCase.voltage];
            const spec = catalog.lookup(testCase.speaker);

            assertClose(spec.maxW, testCase.spec.maxW, `${testCase.label}: maxW`);
            assertClose(spec.standbyW, testCase.spec.standbyW, `${testCase.label}: Leerlauf`);
            assert.equal(spec.match, testCase.spec.match, `${testCase.label}: Trefferart`);
            assert.equal(spec.kind, testCase.spec.kind, `${testCase.label}: Art`);
            assert.equal(
                catalog.needsUsbEthernet(testCase.speaker.model),
                testCase.needsUsbEthernet,
                `${testCase.label}: USB-Adapter noetig`,
            );

            const estimate = estimateSpeaker(testCase.speaker, spec, testCase.adapterW);
            assertClose(estimate.watts, testCase.estimate.watts, `${testCase.label}: Leistung`);
            assertClose(estimate.standbyW, testCase.estimate.standbyW, `${testCase.label}: Leerlaufanteil`);
            assert.equal(estimate.uncertain, testCase.estimate.uncertain, `${testCase.label}: Schaetzmarkierung`);
        }
    });

    it("nimmt die Leerlaufwerte je nach Netzspannung", async () => {
        const era230 = (await SpeakerCatalog.load({}, "230")).lookup({ name: "x", model: "Sonos Era 100" });
        const era120 = (await SpeakerCatalog.load({}, "120")).lookup({ name: "x", model: "Sonos Era 100" });
        assert.notEqual(era230.standbyW, era120.standbyW);
    });

    it("beachtet Benutzerwerte vor der Datenbank", async () => {
        const catalog = await SpeakerCatalog.load({ by_name: { "wohnzimmer · sub": { max_w: 35 } } }, "230");
        const spec = catalog.lookup({ name: "Wohnzimmer · Sub", model: "Sonos Sub" });
        assert.equal(spec.maxW, 35);
        assert.equal(spec.match, "override");
        assert.equal(spec.isEstimate, false, "eigene Werte gelten nicht als Schaetzung");
    });

    it("normalisiert Modellnamen", () => {
        assert.equal(normaliseModel("Sonos Era 100"), "era 100");
        assert.equal(normaliseModel("IKEA SYMFONISK Bookshelf"), "symfonisk bookshelf");
        assert.equal(normaliseModel("  Sonos   Beam  (Gen 2) "), "beam (gen 2)");
    });
});

describe("Benutzerwerte fuer Lampen", () => {
    it("ueberschreibt pro Modell und pro Lampe", async () => {
        const catalog = await LampCatalog.load({
            by_model: { LCT015: { max_w: 9.2, standby_w: 0.38 } },
            by_light: { "lampe am stecker": { max_w: 45, label: "Roehrenradio" } },
        });

        const byModel = catalog.lookup({ id: "1", name: "Egal", modelId: "LCT015", archetype: "", capability: "color" });
        assert.equal(byModel.maxW, 9.2);
        assert.equal(byModel.standbyW, 0.38);

        const byLight = catalog.lookup({
            id: "2",
            name: "Lampe am Stecker",
            modelId: "",
            archetype: "plug",
            capability: "onoff",
        });
        assert.equal(byLight.maxW, 45);
        assert.equal(byLight.label, "Roehrenradio");
        assert.equal(byLight.kind, "plug", "die Art bleibt, wenn sie nicht ueberschrieben wird");
    });
});

describe("Zaehler-IDs aus Raumnamen", () => {
    it("baut lesbare, gueltige IDs", () => {
        assert.equal(slug("Büro & Flur"), "buero-flur");
        assert.equal(slug("Wohnzimmer"), "wohnzimmer");
        assert.equal(meterIdFor("hue", "Wohnzimmer"), "hue-wohnzimmer");
        assert.equal(meterIdFor("sonos", "Küche"), "sonos-kueche");
    });

    it("haelt sich an die erlaubte Laenge und bleibt eindeutig", () => {
        const pattern = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$|^[a-z0-9]$/;
        const long = meterIdFor("hue", "Ein ziemlich langer Raumname im Dachgeschoss hinten");
        assert.ok(long.length <= 32, `zu lang: ${long}`);
        assert.match(long, pattern);

        // Derselbe Name ergibt immer dieselbe ID.
        assert.equal(long, meterIdFor("hue", "Ein ziemlich langer Raumname im Dachgeschoss hinten"));

        // Kollision: zweiter Raum mit gleichem Slug bekommt einen eigenen Namen.
        const first = meterIdFor("hue", "Büro");
        const second = meterIdFor("hue", "Buero", new Set([first]));
        assert.notEqual(first, second);
        assert.match(second, pattern);
    });

    it("kommt auch mit Namen ohne brauchbare Zeichen zurecht", () => {
        const id = meterIdFor("sonos", "♪♪♪");
        assert.match(id, /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$|^[a-z0-9]$/);
    });
});
