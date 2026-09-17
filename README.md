# virtual-power-meter

Virtuelle Matter-Stromzähler in Node.js, gedacht für den Dauerbetrieb als Docker-Container auf einem NAS.

Der Container meldet sich im Netzwerk als **Matter-Bridge** an. Hinter dieser Bridge hängen beliebig viele
virtuelle Zähler, die Wirkleistung, Spannung, Strom sowie Bezugs- und Einspeise­energie melden.

Die Werte kommen aus zwei Richtungen:

- **Über die HTTP-API** – aus einem Skript, aus Node-RED, aus einer Home-Assistant-Automation oder direkt vom
  Wechselrichter. Typischer Fall: Zählerstände, die schon irgendwo im Haus vorliegen (Shelly, P1-Lesekopf),
  als saubere Matter-Geräte bereitstellen.
- **Aus eingebauten Quellen** – [Philips Hue und Sonos](#messquellen-hue-und-sonos) werden selbst abgefragt und
  ihr Verbrauch **geschätzt**. Je Raum entsteht ein Zähler fürs Licht und einer für den Ton. Diese Geräte messen
  ihren Verbrauch nicht selbst; was hier herauskommt, ist ein Modell – gut in Größenordnung und Verlauf, nicht
  auf das Watt genau.

## Was die Ecosysteme davon anzeigen

Ehrliche Einordnung vorweg, damit die Erwartung passt:

| Ecosystem | Ergebnis |
| --- | --- |
| **Home Assistant** (Matter-Integration) | Funktioniert wie gedacht: pro Zähler ein Gerät mit Sensoren für Leistung, Spannung, Strom und Energie. Die Energie-Sensoren lassen sich im Energie-Dashboard verwenden. |
| **Apple Home** | Zeigt Matter-Messwerte bis heute nicht an. Ein Zähler im Modus `plug` erscheint als Steckdose, deren Schalter hier nichts steuert. |
| **Google Home / Alexa** | Wie Apple: keine Anzeige der Messwerte. |
| **SmartThings** | Zeigt bei Steckdosen teilweise Verbrauchswerte an. |

Das Hauptziel ist also Home Assistant. Wer nur Apple Home nutzt, hat von diesem Projekt wenig.

## Aufbau

```
Datenquelle ──HTTP──▶ ┌──────────────────────┐
                      │ virtual-power-meter  │ ──Matter/IPv6──▶ Home Assistant / Controller
Hue-Bridge  ◀──CLIP── │  (Bridge + N Zähler) │
Sonos       ◀──SOAP── └──────────────────────┘
```

- **Bridge**: ein Matter-Knoten, einmal koppeln. Neue Zähler lassen sich später ergänzen, ohne erneut zu koppeln.
- **Zähler**: je ein Endpoint mit den Clustern `ElectricalPowerMeasurement` und `ElectricalEnergyMeasurement`.
  - `kind: "meter"` → Gerätetyp *Electrical Sensor* (0x0510), der spezifikationskonforme Zähler.
  - `kind: "plug"` → *On/Off Plug-in Unit* (0x010A) mit denselben Messclustern, für Ecosysteme, die reine
    Utility-Geräte gar nicht auflisten.
- **Energie**: wird aus der gemeldeten Leistung aufintegriert – oder als absoluter Zählerstand von außen gesetzt.
  Die Stände überleben Neustarts (`/data/energy-state.json`).
- **Quellen**: Hue und Sonos legen ihre Zähler selbst an, einen je Raum. Welche Zähler das sind, merkt sich der
  Container in `/data/source-meters.json` – so bleiben die Geräte im Controller bestehen, auch wenn die
  Hue-Bridge beim Start einmal nicht antwortet.

## Voraussetzungen auf dem NAS

Matter ist wählerisch beim Netzwerk. Diese drei Punkte sind keine Empfehlung, sondern Bedingung:

1. **`network_mode: host`.** Im Bridge-Netz von Docker findet kein Controller das Gerät, weil mDNS-Multicast
   nicht durchgereicht wird.
2. **IPv6 muss aktiv sein** – auf dem NAS und im Docker-Daemon. Matter kommuniziert über IPv6 (Link-Local genügt,
   eine öffentliche IPv6-Adresse ist nicht nötig). Ohne IPv6 startet der Container mit einem entsprechenden
   Hinweis nicht.
3. **NAS und Controller im selben Layer-2-Netz.** Kein VLAN dazwischen ohne mDNS-Reflector, im WLAN keine
   Client-Isolation. Ein Handy im Gäste-WLAN findet die Bridge nicht.

Thread wird nicht benötigt: die Bridge läuft über das normale LAN/WLAN.

## Einrichtung auf dem NAS

### 1. Docker-Daemon auf IPv6 prüfen

```bash
cat /etc/docker/daemon.json
```

Falls `"ipv6": true` fehlt, ergänzen und den Docker-Dienst neu starten:

```json
{
  "ipv6": true,
  "fixed-cidr-v6": "fd00:dead:beef::/48"
}
```

Bei `network_mode: host` nutzt der Container ohnehin den IPv6-Stack des NAS – entscheidend ist, dass das
Betriebssystem selbst IPv6 nicht abgeschaltet hat.

### 2. Projekt ablegen

```bash
git clone https://github.com/marcelschreiner/virtual-power-meter.git
cd virtual-power-meter
mkdir -p data config
cp config/meters.example.json config/meters.json
```

`config/meters.json` an die eigenen Zähler anpassen (siehe [Konfiguration](#konfiguration)).

### 3. Starten

```bash
docker compose up -d --build
docker compose logs -f
```

Beim ersten Start steht der QR-Code als ASCII-Grafik im Log, dazu der manuelle Kopplungscode:

```
NOTICE Commissioning  virtual-power-meter is uncommissioned
       passcode: 20202021  discriminator: 3840  manual pairing code: 34970112332
  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  █ ▄▄▄▄▄ ██▀▄▀▄█ ▄▄▄▄▄ █
  ...
```

Dieselben Codes liefert auch `curl http://<nas-ip>:8080/api/commissioning`.

### 4. Koppeln

**Home Assistant:** *Einstellungen → Geräte & Dienste → Gerät hinzufügen → Matter*, dann den QR-Code scannen
oder den 11-stelligen Code eintippen. Danach erscheint pro Zähler ein eigenes Gerät.

**Weitere Ecosysteme:** nicht erneut mit demselben Code koppeln, sondern in der bereits gekoppelten App die
Funktion „Gerät teilen“ / „Zu anderer Plattform hinzufügen“ verwenden. Matter vergibt dafür einen neuen
temporären Code.

### 5. Quellen aktivieren

Sind Hue oder Sonos in `config/meters.json` eingeschaltet, legen sie ihre Zähler selbst an. Sonos wird von
selbst gefunden; Hue braucht Adresse und App-Key der Bridge. Beides kommt aus der Umgebung – am besten aus
einer `.env` neben der `docker-compose.yml` (Vorlage: [`.env.example`](.env.example)):

```bash
cp .env.example .env
```

Dort `HUE_BRIDGE_IP` und `HUE_APP_KEY` eintragen (siehe [App-Key besorgen](#app-key-besorgen)), dann
`docker compose up -d`. Kontrolle:

```bash
curl -s http://<nas-ip>:8080/api/sources
```

### 6. Werte von Hand einspeisen

Für Zähler, die unter `meters[]` konfiguriert sind:

```bash
curl -X POST http://<nas-ip>:8080/api/meters/hausanschluss \
  -H 'content-type: application/json' \
  -d '{"power": 2350}'
```

Ab hier läuft der Energiezähler von selbst weiter, solange keine neue Leistung gemeldet wird.

### Hinweise je NAS

- **Synology (DSM 7):** Die Container-Manager-GUI kann kein Host-Netzwerk mit allen Optionen sauber setzen –
  das Projekt über SSH mit `docker compose` starten. DSM betreibt selbst einen Bonjour-Dienst auf Port 5353;
  das ist in der Regel unproblematisch, weil sich beide den Port teilen. Falls doch `EADDRINUSE` im Log steht,
  hilft `VPM_MATTER_PORT` allein nicht – dann den DSM-Dienst „Bonjour“ deaktivieren.

### Port 5540 ist belegt

```
Start fehlgeschlagen: [address-in-use] Cannot bind {::}:5540 because port is already in use
```

Im Host-Netzwerkmodus teilt sich der Container den Port-Raum des NAS – irgendein anderer Prozess hält 5540/udp
bereits. Meist ist das ein zweiter Matter-Dienst (Matter-Server von Home Assistant, Homebridge, ioBroker) oder
eine ältere Instanz dieses Containers. Zuerst den Restart-Loop stoppen, dann nachsehen:

```bash
docker compose down
sudo ss -ulpn | grep 5540 || sudo netstat -ulpn | grep 5540
docker ps -a | grep -i -E 'matter|power-meter'
```

Gehört der Port einem Dienst, den man behalten will, bekommt der Zähler einen eigenen Port – Matter gibt den
Port über mDNS bekannt, Controller finden das Gerät also weiterhin:

```yaml
environment:
  - VPM_MATTER_PORT=5541
```

Nach einem Portwechsel muss **nicht** neu gekoppelt werden, solange `./data` erhalten bleibt.
- **QNAP:** In Container Station „Host“ als Netzwerkmodus wählen, ansonsten identisch.
- **Unraid:** Netzwerktyp `host`, die beiden Pfade `/data` und `/config` als Volume-Mappings anlegen.
- **Raspberry Pi / Linux-Server:** funktioniert unverändert, das Image baut auch auf arm64.

## Messquellen: Hue und Sonos

Neben den von Hand gefütterten Zählern kann der Container zwei Quellen selbst abfragen. Beide sind **rein
lesend** – es wird nie etwas geschaltet.

### Welche Zähler dabei entstehen

| Zähler | Inhalt |
| --- | --- |
| `hue-<raum>` | Summe aller Hue-Lampen dieses Raums, inklusive ihres Standby-Verbrauchs |
| `sonos-<raum>` | Summe aller Sonos-Geräte dieser Zone |
| `hue-bridge` | Eigenverbrauch der Hue-Bridge (Vorgabe 1,9 W) |

Die Raumnamen kommen von der Hue-Bridge beziehungsweise aus den Sonos-Zonennamen. Lampen ohne Raumzuordnung
landen gesammelt unter `hue-ohne-raum`. Neue Räume tauchen von selbst auf, ohne dass neu gekoppelt werden muss.

Zwei Dinge zur Einordnung:

- **Antwortet eine Quelle nicht**, bleibt der zuletzt bekannte Wert stehen und der Zähler meldet sich als
  *nicht erreichbar* (`reachable = false`), statt stillschweigend weiterzulaufen. Home Assistant zeigt das
  Gerät dann als nicht verfügbar an.
- **Die Zähler bleiben bestehen**, auch wenn die Bridge beim Start gerade weg ist – die Liste steht in
  `/data/source-meters.json`.

### Hue einrichten

Die Bridge braucht zwei Angaben, beide als Umgebungsvariable:

| Variable | Inhalt |
| --- | --- |
| `VPM_HUE_BRIDGE_IP` | Adresse der Bridge, z. B. `192.168.1.42` |
| `VPM_HUE_APP_KEY` | App-Key der Bridge (siehe unten) |

In der mitgelieferten `docker-compose.yml` sind sie bereits verdrahtet und lesen aus einer `.env`-Datei
neben der Compose-Datei:

```
HUE_BRIDGE_IP=192.168.1.42
HUE_APP_KEY=abcdef0123456789abcdef0123456789abcdef01
```

Die `.env` ist per `.gitignore` ausgenommen, der Schlüssel landet also nicht im Repository. Wer lieber ohne
`.env` arbeitet, trägt die Werte direkt in der `docker-compose.yml` ein oder – als dritte Möglichkeit – unter
`sources.hue` in der `config/meters.json`. Die Umgebung hat immer Vorrang.

Die Adresse der Bridge steht in der Hue-App unter *Einstellungen → Hue Bridges → i*.

#### App-Key besorgen

Der App-Key wird einmal von der Bridge selbst ausgestellt. Erst die runde Taste auf der Bridge drücken, dann
innerhalb von 30 Sekunden:

```bash
curl -k -X POST https://192.168.1.42/api -d '{"devicetype":"virtual_power_meter#nas"}'
```

Die Antwort enthält den Schlüssel:

```json
[{"success":{"username":"abcdef0123456789abcdef0123456789abcdef01"}}]
```

Dieser `username` ist der App-Key. `-k` ist nötig, weil die Bridge im lokalen Netz ein selbstsigniertes
Zertifikat benutzt, das keiner öffentlichen Zertifizierungsstelle bekannt ist. Kommt stattdessen
`"error": {"type": 101}`, war die Taste nicht (oder zu lange nicht) gedrückt – einfach wiederholen.

Der Schlüssel bleibt gültig, bis man ihn in der Hue-App zurückzieht. Er erlaubt vollen Zugriff auf die Bridge;
dieses Projekt liest damit ausschließlich, geschaltet wird nie etwas. Wer die Variablen in der
`docker-compose.yml` setzt, sollte wissen, dass `docker inspect` sie anzeigt – deshalb die `.env`.

### Sonos einrichten

Nichts einzurichten: Sonos wird per SSDP-Multicast gefunden, sobald `sources.sonos.enabled` auf `true` steht.
Abgefragt wird rein lesend (`GetZoneGroupState`, `GetTransportInfo`, `GetVolume`) — geschaltet wird nie etwas.
Das setzt `network_mode: host` voraus – im Bridge-Netz von Docker kommt kein Multicast an. Findet die Suche
nichts, lassen sich die Adressen fest vorgeben:

```json
"sources": { "sonos": { "enabled": true, "ips": ["10.0.0.5", "10.0.0.6"] } }
```

### Wie geschätzt wird

Die Hue-Bridge verrät pro Lampe Modell, Schaltzustand, Helligkeit und Farbe. Daraus ergibt sich:

```
aus:  P = P_standby
an:   P = P_standby + P_treiber + (P_max − P_standby − P_treiber) · b^γ · f_farbe
```

**Helligkeitskurve (`b^γ`, γ = 2.0).** Hue rechnet den Dimmwert intern von einer wahrnehmungs-linearen Skala auf
den LED-Strom um. Nachmessungen an echten Lampen ergeben dabei einen quadratischen Zusammenhang – nicht den
exponentiellen, den man wegen des logarithmischen Sehempfindens vermuten würde.

**Farbfaktor (`f_farbe`).** Eine gesättigte Farbe steuert nur einen Teil der LED-Kanäle an. Entscheidend ist der
Abstand des Farborts zur Planckschen Kurve, nicht das RGB-Verhältnis: eine Farblampe erzeugt Weißtöne mit ihren
eigenen weißen LEDs und zieht dabei fast die volle Leistung – auch bei warmem Weiß, das in sRGB kaum Blauanteil
hat. Erst wenn die Farbe die Weißkurve verlässt, übernehmen die Farbkanäle:

| Farbe bei 100 % Helligkeit | Anteil der Maximalleistung |
| --- | --- |
| jeder Weißton von 2000 K bis 6500 K | 100 % |
| Pastelltöne | 60–80 % |
| Magenta (zwei Kanäle) | 67 % |
| Rot, Grün, Tiefblau | 33–37 % |

**Grundlast.** Jede Lampe verbraucht auch im ausgeschalteten Zustand Strom, weil ihr Funkmodul lauschen muss –
gemessen rund 0,32–0,37 W pro Farblampe, 0,1 W pro Lightstrip. Bei 20 Lampen sind das etwa 6 W rund um die Uhr.

**Gruppen statt Einzelgeräte.** Sonos führt die Wiedergabe pro *Gruppe*, nicht pro Lautsprecher. Nur der
Koordinator einer Gruppe gibt darüber verlässlich Auskunft — ein Stereopaar-Partner oder ein zugeschaltetes
Gerät meldet über sich selbst gern noch den Zustand von vorhin. Der Container liest deshalb zuerst die
Gruppenstruktur (`GetZoneGroupState`) und überträgt den Zustand des Koordinators auf alle Mitglieder, Satelliten
wie Sub und Surrounds eingeschlossen. Die Lautstärke bleibt geräteeigen, denn jeder Verstärker hat seine eigene.

Ist die Struktur nicht zu lesen, fällt die Abfrage auf die Einzelauskunft der Geräte zurück — ungenauer, aber
besser als keine Werte. Ob es geklappt hat, steht in `GET /api/sources` unter `status.sonos.groups`: `0` heißt
Rückfallbetrieb.

**Lautsprecher.** Gröber, weil ein Verstärker Leistung nach dem zieht, was er gerade wiedergibt:

```
Leerlauf:   P = P_idle
Wiedergabe: P = P_idle + (P_max − P_idle) · Lautstärke²
```

Die Leerlaufwerte stammen direkt von Sonos, das die Zahlen für jedes Modell veröffentlicht (230-V-Spalte,
umschaltbar über `mainsVoltage`). Für den Abspielbetrieb veröffentlicht Sonos nichts – diese Maximalwerte sind
aus Verstärkerleistung und Community-Messungen abgeleitet und **durchweg Schätzungen**. Über das Jahr gerechnet
macht der Leerlauf ohnehin meist mehr aus, und der beruht auf Herstellerangaben.

**USB-Netzwerkadapter.** Era 100 und Era 300 haben keinen eingebauten Netzwerkanschluss; wer sie ans Kabel
hängt, braucht den USB-Adapter, der seinen Strom durch den Lautsprecher zieht und in der offiziellen
Leerlauftabelle fehlt. Erkannt wird er indirekt über `/status/ifconfig`, angesetzt sind 0,5 W
(`usbAdapterWatts`, `0` schaltet ihn ab).

### Wie genau ist das?

Es ist eine Schätzung, keine Messung. Größenordnung und zeitlicher Verlauf stimmen gut; für einzelne Geräte sind
Abweichungen von 10–20 % normal. Gründe: Die Maximalwerte stammen überwiegend von Typenschildern und liegen
nachgemessen oft darunter; der Leistungsfaktor der Hue-Netzteile ist niedrig; Modelle ohne exakten
Datenbankeintrag werden aus ähnlichen abgeleitet; ein Hue Smart Plug weiß nichts über das angeschlossene Gerät.

Welche Geräte betroffen sind, zeigt `GET /api/sources` – dort steht pro Gerät, aus welchem Datenbankeintrag die
Werte stammen (`match`) und ob sie geraten sind (`estimate`).

### Eigene Werte hinterlegen

Wer nachmisst oder bessere Angaben hat, trägt sie unter `overrides` ein; diese Werte haben immer Vorrang vor der
mitgelieferten Datenbank (78 Lampen- und 38 Lautsprecher-Modelle):

```json
"sources": {
  "hue": {
    "overrides": {
      "by_model": { "LCT015": { "max_w": 9.2, "standby_w": 0.38 } },
      "by_light": { "Lampe am Stecker": { "max_w": 45.0, "label": "Röhrenradio" } }
    }
  },
  "sonos": {
    "overrides": {
      "by_model": { "symfonisk bookshelf": { "max_w": 8.0, "standby_w": 2.4 } },
      "by_name": { "Wohnzimmer · Sub": { "max_w": 35.0 } }
    }
  }
}
```

`by_light` akzeptiert den Lampennamen oder die ID aus `/api/sources`. Für einen Smart Plug ist `max_w` der
Verbrauch des angeschlossenen Geräts. Bei Lautsprechern ist `by_model` der Modellname in Kleinbuchstaben ohne
„Sonos" (also `era 100`, `beam (gen 2)`) und `standby_w` der Leerlaufwert.

### Quellen der Zahlen

- [hue-power-tracker](https://github.com/tvwerkhoven/hue-power-tracker) und der
  [zugehörige Blogbeitrag](https://www.vanwerkhoven.org/blog/2019/measuring-calibrated-hue-energy-usage-via-bridge/)
  – kalibrierte Messungen, aus denen die quadratische Helligkeitskurve stammt.
- [Didier Stevens: Power Consumption Of A Philips Hue lamp In Off State](https://blog.didierstevens.com/2022/04/03/power-consumption-of-a-philips-hue-lamp-in-off-state/)
  – Langzeitmessung des Standby-Verbrauchs.
- [Sonos: Power Consumption While Idle](https://support.sonos.com/en-us/article/sonos-power-consumption-while-idle)
  – Herstellerangaben, Grundlage sämtlicher Leerlaufwerte.

## HTTP-API

Alle Pfade unter `/api` verlangen einen Token, sobald `VPM_API_TOKEN` oder `api.token` gesetzt ist –
als `Authorization: Bearer <token>` oder `X-API-Key: <token>`. `/health` ist immer offen.

| Methode | Pfad | Zweck |
| --- | --- | --- |
| `GET` | `/health` | Lebenszeichen, Anzahl Zähler, Kopplungsstatus |
| `GET` | `/api/meters` | Alle Zähler mit aktuellen Werten |
| `GET` | `/api/meters/<id>` | Ein Zähler |
| `POST` | `/api/meters/<id>` | Messwerte für einen Zähler setzen |
| `POST` | `/api/meters` | Messwerte für mehrere Zähler auf einmal |
| `GET` | `/api/commissioning` | Kopplungscodes und Fabric-Anzahl |
| `GET` | `/api/sources` | Zustand von Hue und Sonos samt Einzelgeräten |

### Felder eines Messwerts

| Feld | Einheit | Bedeutung |
| --- | --- | --- |
| `power` | W | Wirkleistung. **Positiv = Bezug, negativ = Einspeisung.** |
| `voltage` | V | Spannung. Ohne Angabe wird `nominalVoltage` verwendet. |
| `current` | A | Strom. Ohne Angabe aus Leistung, Spannung und Phasenzahl berechnet. |
| `energyImported` | kWh | Absoluter Zählerstand Bezug. |
| `energyExported` | kWh | Absoluter Zählerstand Einspeisung. |

Mindestens ein Feld muss gesetzt sein; unbekannte Felder werden mit `400` abgelehnt.

**Wichtig zur Energie:** Solange nur `power` geliefert wird, integriert der Dienst die Energie selbst auf
(Modus `integrate`). Sobald einmal `energyImported` oder `energyExported` gesetzt wurde, schaltet der Zähler
dauerhaft auf `external` um und übernimmt nur noch die gelieferten Stände – sonst würden sich eigene
Integration und echter Zählerstand addieren.

### Beispiele

Mehrere Zähler in einem Aufruf:

```bash
curl -X POST http://<nas-ip>:8080/api/meters \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer geheim' \
  -d '{"hausanschluss": {"power": 1850}, "pv": {"power": -4200}}'
```

Echte Zählerstände statt Integration:

```bash
curl -X POST http://<nas-ip>:8080/api/meters/hausanschluss \
  -H 'content-type: application/json' \
  -d '{"power": 1850, "energyImported": 45321.7, "energyExported": 12880.4}'
```

Aus Home Assistant heraus (z. B. alle 30 Sekunden per Automation):

```yaml
action: rest_command.push_power
data:
  payload: >-
    {"power": {{ states('sensor.p1_active_power') | float(0) }},
     "energyImported": {{ states('sensor.p1_energy_import') | float(0) }}}
```

```yaml
# configuration.yaml
rest_command:
  push_power:
    url: http://<nas-ip>:8080/api/meters/hausanschluss
    method: POST
    content_type: application/json
    payload: "{{ payload }}"
```

## Konfiguration

`config/meters.json`, vollständiges Beispiel in [`config/meters.example.json`](config/meters.example.json).
Fehlt die Datei, startet der Dienst mit einem einzigen Zähler namens `meter-1`.

### `bridge`

| Feld | Default | Bedeutung |
| --- | --- | --- |
| `name` | `Virtual Power Meter` | Anzeigename der Bridge |
| `vendorName` | `matter.js` | Herstellername |
| `vendorId` | `0xFFF1` | Von der CSA für Eigenbau reservierte Test-Vendor-ID |
| `productName` / `productId` | `Virtual Power Meter Bridge` / `0x8001` | Produktangaben |
| `serialNumber` | `vpm-0001` | Seriennummer, Basis für die IDs der Zähler |
| `passcode` | `20202021` | Kopplungs-Passcode |
| `discriminator` | `3840` | Unterscheidungsmerkmal beim Koppeln (0–4095) |
| `port` | `5540` | UDP-Port des Matter-Knotens |

Passcode und Discriminator vor dem ersten Koppeln ändern, wenn mehrere Instanzen im selben Netz laufen.
Nach dem Koppeln ändert eine Änderung nichts mehr – dafür müsste die Kopplung zurückgesetzt werden.

### `meters[]`

| Feld | Default | Bedeutung |
| --- | --- | --- |
| `id` | – | Pflicht. Kleinbuchstaben, Ziffern, Bindestriche. Wird in der API und als Endpoint-ID verwendet. |
| `name` | = `id` | Anzeigename im Ecosystem |
| `kind` | `meter` | `meter` (Electrical Sensor) oder `plug` (Steckdose mit Messung) |
| `nominalVoltage` | `230` | Nennspannung in V |
| `phases` | `1` | `1` oder `3`; beeinflusst nur den berechneten Strom (pro Phase) |
| `initialEnergyImportedKwh` | `0` | Startwert Bezug, greift nur beim allerersten Start |
| `initialEnergyExportedKwh` | `0` | Startwert Einspeisung |
| `simulation.enabled` | `false` | Erzeugt Testwerte ohne Datenquelle |
| `simulation.minWatts` / `maxWatts` | `0` / `3000` | Grenzen des simulierten Verlaufs (negativ = Einspeisung) |
| `simulation.intervalSeconds` | `10` | Abstand der simulierten Messwerte |

### Weitere Felder

| Feld | Vorgabe | Bedeutung |
| --- | --- | --- |
| `integrationIntervalSeconds` | `10` | Sekunden zwischen zwei Energie-Ticks |

Dieser Tick ist zugleich der einzige regelmäßige Schreibzugriff des Containers: Er sichert `energy-state.json`
(rund 1 KB). Bei der Vorgabe von 10 Sekunden sind das etwa 8 600 Schreibvorgänge und 9,5 MB pro Tag – auf einer
SSD belanglos, auf Festplatten verhindert es aber zuverlässig, dass sie je in den Standby gehen. Wer das nicht
will, setzt das Intervall hoch; `3600` schreibt einmal pro Stunde.

Die Genauigkeit hängt nicht daran: Aufintegriert wird bei **jedem** Messwert mit der tatsächlich verstrichenen
Zeit, der Tick ist nur das Sicherheitsnetz für den Fall, dass gar keine Werte mehr kommen. Der Preis eines
großen Intervalls ist allein, dass bei einem **unsauberen** Ende (Stromausfall, harter Kill) die seitdem
aufgelaufene Energie fehlt. Beim normalen Stoppen wird noch einmal gesichert.

### `sources.hue`

| Feld | Vorgabe | Bedeutung |
| --- | --- | --- |
| `enabled` | `false` | Hue-Bridge abfragen |
| `bridgeIp` | *(leer)* | Adresse der Bridge; normalerweise über `VPM_HUE_BRIDGE_IP` |
| `appKey` | *(leer)* | App-Key; normalerweise über `VPM_HUE_APP_KEY` |
| `bridgeWatts` | `1.9` | Eigenverbrauch der Bridge, eigener Zähler; `0` lässt ihn weg |
| `gamma` | `2.0` | Exponent der Helligkeitskurve |
| `intervalSeconds` | `2` | Abfrageintervall, Minimum 0,5 s |
| `overrides` | `{}` | eigene Leistungsdaten, siehe [oben](#eigene-werte-hinterlegen) |

### `sources.sonos`

| Feld | Vorgabe | Bedeutung |
| --- | --- | --- |
| `enabled` | `false` | Sonos-Geräte abfragen |
| `ips` | `[]` | feste Adressen statt SSDP-Suche |
| `mainsVoltage` | `"230"` | Netzspannung für die Leerlaufwerte (`"230"` oder `"120"`) |
| `usbAdapterWatts` | `0.5` | Aufschlag je USB-Netzwerkadapter am Era; `0` schaltet ihn ab |
| `intervalSeconds` | `3` | Abfrageintervall, Minimum 3 s (je Player zwei Anfragen) |
| `overrides` | `{}` | eigene Leistungsdaten |

### Umgebungsvariablen

Sie überschreiben die Werte aus der Datei – praktisch, wenn man im Container ohne Datei-Mount arbeiten will.

| Variable | Bedeutung |
| --- | --- |
| `VPM_CONFIG` | Pfad zur Konfigurationsdatei (Container: `/config/meters.json`) |
| `VPM_STORAGE` | Datenverzeichnis für Kopplung und Zählerstände (Container: `/data`) |
| `VPM_MATTER_PORT` | UDP-Port des Matter-Knotens |
| `VPM_HUE_ENABLED` | Hue-Quelle ein-/ausschalten |
| `VPM_HUE_BRIDGE_IP` | Adresse der Hue-Bridge |
| `VPM_HUE_APP_KEY` | App-Key der Hue-Bridge |
| `VPM_HUE_BRIDGE_WATTS` | Eigenverbrauch der Bridge |
| `VPM_HUE_GAMMA` | Exponent der Helligkeitskurve |
| `VPM_HUE_INTERVAL` | Abfrageintervall Hue in Sekunden |
| `VPM_SONOS_ENABLED` | Sonos-Quelle ein-/ausschalten |
| `VPM_SONOS_IPS` | feste Sonos-Adressen, kommagetrennt |
| `VPM_SONOS_MAINS` | `230` oder `120` |
| `VPM_SONOS_USB_WATTS` | Aufschlag je USB-Netzwerkadapter |
| `VPM_SONOS_INTERVAL` | Abfrageintervall Sonos in Sekunden |
| `VPM_PASSCODE`, `VPM_DISCRIMINATOR` | Kopplungsparameter |
| `VPM_VENDOR_ID`, `VPM_PRODUCT_ID`, `VPM_SERIAL` | Geräteangaben |
| `VPM_API_ENABLED`, `VPM_API_HOST`, `VPM_API_PORT`, `VPM_API_TOKEN` | HTTP-API |
| `VPM_INTEGRATION_INTERVAL` | Sekunden zwischen zwei Energie-Ticks (Default 10) |
| `VPM_LOG_LEVEL` | `DEBUG`, `INFO`, `NOTICE`, `WARN`, `ERROR`, `FATAL` |

## Betrieb

- **Kopplung und Zählerstände liegen in `/data`.** Wird dieses Verzeichnis gelöscht, ist die Bridge wieder
  fabrikneu und muss neu gekoppelt werden – die Geräte müssen dann auch im Controller entfernt werden.
- **Zähler hinzufügen:** Eintrag in `meters.json` ergänzen, Container neu starten. Die Bridge bleibt gekoppelt,
  das neue Gerät taucht im Controller von selbst auf.
- **Zähler entfernen:** Eintrag löschen und neu starten; im Controller verschwindet das Gerät. Zähler, die eine
  Quelle angelegt hat, stehen in `/data/source-meters.json` – wer einen Raum in Hue umbenannt hat und den alten
  Zähler loswerden will, löscht dort den Eintrag und startet neu.
- **Räume umbenennen:** Der Zähler behält Name und ID, die er beim Anlegen bekommen hat; im Controller ändert
  sich also nichts von selbst. Für einen sauberen Neuanfang den Eintrag aus `/data/source-meters.json` löschen.
- **Update:** `git pull && docker compose up -d --build`. `/data` bleibt unangetastet, die Kopplung bleibt bestehen.
- **Sicherheit:** Der Container läuft im Host-Netz und ist damit im LAN erreichbar. Wenn die API von außerhalb
  des NAS genutzt wird, `VPM_API_TOKEN` setzen. Ins Internet gehört weder die API noch der Matter-Port.

### Ohne Image-Build aktualisieren

Auf einem NAS ohne Terminal ist ein Image-Neubau lästig: Container löschen, Image löschen, Projekt neu anlegen –
und `npm ci` läuft jedes Mal auf schwacher Hardware. Wer den Code ohnehin auf einem anderen Rechner übersetzt,
kann ihn stattdessen mounten:

```yaml
    volumes:
      - ./dist:/app/dist:ro
```

Das Image liefert dann nur noch `node_modules`, der Code kommt aus dem Ordner. Eine Codeänderung heißt danach:
`dist/` auf das NAS kopieren und den Container neu starten – kein Build, keine Wartezeit.

Zu beachten:

- Das Image muss **einmal** gebaut werden, damit `node_modules` darin liegt. Danach wird es nur noch fällig,
  wenn sich `package.json` ändert.
- `dist/` muss vollständig sein, inklusive `dist/sources/data/*.json`. `npm run build` erzeugt genau das.
- Beim Kopieren vollständig ersetzen (z. B. `rsync -rc --delete`), sonst bleiben alte Dateien liegen.
- Die Abhängigkeiten selbst zu mounten lohnt nicht: 165 MB in rund 27 000 Dateien brauchen über eine
  SMB-Freigabe gut anderthalb Stunden – gemessen, nicht geschätzt.

## Fehlersuche

| Symptom | Ursache und Abhilfe |
| --- | --- |
| `Cannot bind to {::}:5353 (EAFNOSUPPORT)` | Kein IPv6. Auf NAS und Docker-Daemon aktivieren. |
| `EADDRINUSE` auf 5353 | Anderer mDNS-Dienst (Avahi/Bonjour) blockiert den Port exklusiv – Dienst stoppen. |
| Controller findet die Bridge nicht | `network_mode: host` gesetzt? Controller im selben Subnetz? Client-Isolation im WLAN aus? |
| Kopplung bricht bei ~30 % ab | Meist mDNS: VLAN-Grenze oder fehlender mDNS-Reflector zwischen Controller und NAS. |
| Geräte erscheinen, zeigen aber keine Werte | Es wurden noch keine Messwerte gesendet. `GET /api/meters` prüfen. |
| Energie steigt nicht | Zähler steht auf `energyMode: "external"` – dann kommen die Stände ausschließlich von außen. |
| Nach Neustart alles neu koppeln nötig | `/data` ist nicht persistent gemountet. |
| Keine Hue-Zähler, Log nennt `VPM_HUE_BRIDGE_IP`/`VPM_HUE_APP_KEY` | Eine der beiden Variablen fehlt oder ist leer. `docker compose config` zeigt, was wirklich ankommt. |
| Log sagt „Die Bridge weist den App-Key zurueck" | Der Schlüssel ist falsch oder in der Hue-App zurückgezogen – neuen holen (siehe [App-Key besorgen](#app-key-besorgen)). |
| Hue-Zähler sind „nicht erreichbar" | Bridge antwortet nicht: Adresse prüfen, `GET /api/sources` zeigt den Fehlertext. |
| Keine Sonos-Geräte gefunden | SSDP-Multicast blockiert. `network_mode: host` gesetzt? Sonst Adressen über `sources.sonos.ips` vorgeben. |
| Ein Gerät zieht offensichtlich zu viel/zu wenig | `GET /api/sources` zeigt `match` und `estimate`; eigene Werte unter `overrides` hinterlegen. |

Mehr Details im Log mit `VPM_LOG_LEVEL=DEBUG`.

## Entwicklung

```bash
npm install
npm run build
npm test          # baut und führt die Tests aus
node dist/index.js
```

Die Tests laufen gegen den Netzwerk-Simulator von matter.js und brauchen daher weder IPv6 noch Multicast –
sie funktionieren auch in CI-Containern. Abgedeckt sind Bridge-Aufbau, HTTP-API, Einheitenumrechnung,
Energie-Integration und Persistenz.

```
src/
  index.ts              Start, Shutdown, periodischer Energie-Tick
  config.ts             Konfiguration aus JSON + Umgebungsvariablen
  meter.ts              Zählerlogik: Messwerte, Integration, Matter-Attribute
  http-api.ts           HTTP-API ohne Framework
  persistence.ts        Zählerstände als JSON
  matter/
    bridge.ts           Matter-Knoten, Aggregator, Endpoints
    endpoints.ts        Endpoint-Typen und Cluster-Auswahl
```

Gebaut mit [matter.js](https://github.com/project-chip/matter.js).
