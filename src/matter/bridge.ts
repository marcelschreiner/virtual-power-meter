/**
 * Aufbau des Matter-Knotens.
 *
 * Alle Zaehler haengen als Bridged Devices unter einem Aggregator. So muss man
 * genau einmal koppeln und kann danach Zaehler hinzufuegen, ohne neu zu koppeln.
 */
import { createHash } from "node:crypto";
import { Endpoint, Environment, ServerNode, VendorId } from "@matter/main";
import { MeasurementType } from "@matter/main/types";
import { ElectricalPowerMeasurement } from "@matter/main/clusters/electrical-power-measurement";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import type { AppConfig, MeterConfig } from "../config.js";
import { VirtualMeter } from "../meter.js";
import type { EnergyStore } from "../persistence.js";
import { VirtualMeterEndpoint, VirtualPlugEndpoint } from "./endpoints.js";

export interface PairingInfo {
    commissioned: boolean;
    fabrics: number;
    manualPairingCode?: string;
    qrPairingCode?: string;
}

export interface Bridge {
    node: ServerNode;
    meters: Map<string, VirtualMeter>;
    pairing(): PairingInfo;
    /**
     * Zaehler zur Laufzeit ergaenzen. Quellen wie Hue oder Sonos kennen ihre
     * Raeume erst nach der ersten Abfrage; ein Bridged Device darf jederzeit
     * dazukommen, ohne dass neu gekoppelt werden muss. Ein bereits vorhandener
     * Zaehler wird unveraendert zurueckgegeben.
     */
    addMeter(meterConfig: MeterConfig): Promise<VirtualMeter>;
}

/**
 * Messgenauigkeit, die der Zaehler meldet. Virtuelle Werte sind exakt das, was
 * hineingegeben wurde - deshalb "nicht selbst gemessen" und 0 % Abweichung.
 */
function accuracy(measurementType: MeasurementType, min: number, max: number) {
    return {
        measurementType,
        measured: false,
        minMeasuredValue: min,
        maxMeasuredValue: max,
        accuracyRanges: [{ rangeMin: min, rangeMax: max, percentMax: 0, percentMin: 0 }],
    };
}

/** Wird in BasicInformation gemeldet; Ecosysteme zeigen das als Firmware-Stand. */
const SOFTWARE_VERSION = 1;
const SOFTWARE_VERSION_STRING = "1.0.0";

// Grenzwerte grosszuegig: +/- 1 MW, +/- 1000 A, 0 - 1000 V.
const POWER_RANGE_MW = 1_000_000_000;
const CURRENT_RANGE_MA = 1_000_000;
const VOLTAGE_MAX_MV = 1_000_000;
const ENERGY_RANGE_MWH = Number.MAX_SAFE_INTEGER;

/**
 * Matter verlangt, dass uniqueId und serialNumber verschieden sind. Der Hash
 * bleibt ueber Neustarts stabil, solange Seriennummer und Zaehler-ID gleich sind.
 */
function uniqueId(...parts: string[]): string {
    return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 16);
}

// Laengengrenzen aus der Matter-Spezifikation fuer BridgedDeviceBasicInformation.
// Wer sie reisst, bekommt beim Anlegen des Endpoints einen Constraint-Fehler -
// und das mitten im Betrieb, wenn der Zaehler aus einem langen Raumnamen entsteht.
const MAX_SERIAL_NUMBER = 32;
const MAX_NODE_LABEL = 32;
const MAX_PRODUCT_LABEL = 64;

/**
 * Seriennummer eines Bridged Device: "<bridge>-<zaehler>", gekuerzt auf 32
 * Zeichen. Passt der Name nicht, haengt ein kurzer Hash des vollen Namens
 * hinten dran - so bleibt die Nummer eindeutig und ueber Neustarts stabil.
 */
function serialNumberFor(bridgeSerial: string, meterId: string): string {
    const plain = `${bridgeSerial}-${meterId}`;
    if (plain.length <= MAX_SERIAL_NUMBER) return plain;

    const suffix = `-${uniqueId(bridgeSerial, meterId).slice(0, 8)}`;
    return `${plain.slice(0, MAX_SERIAL_NUMBER - suffix.length)}${suffix}`;
}

function clampLabel(text: string, max: number): string {
    return text.length <= max ? text : text.slice(0, max);
}

function bridgedInfo(meter: MeterConfig, config: AppConfig) {
    return {
        nodeLabel: clampLabel(meter.name, MAX_NODE_LABEL),
        productName: meter.kind === "plug" ? "Virtual Metering Plug" : "Virtual Power Meter",
        productLabel: clampLabel(meter.name, MAX_PRODUCT_LABEL),
        vendorName: config.bridge.vendorName,
        vendorId: VendorId(config.bridge.vendorId),
        serialNumber: serialNumberFor(config.bridge.serialNumber, meter.id),
        uniqueId: uniqueId(config.bridge.serialNumber, meter.id),
        reachable: true,
    };
}

function measurementDefaults(meter: VirtualMeter) {
    const initial = meter.initialMeasurementState;
    return {
        electricalPowerMeasurement: {
            powerMode: ElectricalPowerMeasurement.PowerMode.Ac,
            numberOfMeasurementTypes: 3,
            accuracy: [
                accuracy(MeasurementType.ActivePower, -POWER_RANGE_MW, POWER_RANGE_MW),
                accuracy(MeasurementType.Voltage, 0, VOLTAGE_MAX_MV),
                accuracy(MeasurementType.ActiveCurrent, -CURRENT_RANGE_MA, CURRENT_RANGE_MA),
            ],
            ...initial.electricalPowerMeasurement,
        },
        electricalEnergyMeasurement: {
            accuracy: accuracy(MeasurementType.ElectricalEnergy, 0, ENERGY_RANGE_MWH),
            ...initial.electricalEnergyMeasurement,
        },
    };
}

export async function createBridge(config: AppConfig, store: EnergyStore): Promise<Bridge> {
    const environment = Environment.default;
    environment.vars.set("storage.path", config.storagePath);

    const node = await ServerNode.create({
        id: "virtual-power-meter",
        network: { port: config.bridge.port },
        commissioning: {
            passcode: config.bridge.passcode,
            discriminator: config.bridge.discriminator,
        },
        productDescription: {
            name: config.bridge.productName,
            deviceType: AggregatorEndpoint.deviceType,
        },
        basicInformation: {
            vendorName: config.bridge.vendorName,
            vendorId: VendorId(config.bridge.vendorId),
            productName: config.bridge.productName,
            productLabel: config.bridge.name,
            productId: config.bridge.productId,
            nodeLabel: config.bridge.name,
            serialNumber: config.bridge.serialNumber,
            uniqueId: uniqueId(config.bridge.serialNumber),
            hardwareVersion: 1,
            hardwareVersionString: "1.0",
            softwareVersion: SOFTWARE_VERSION,
            softwareVersionString: SOFTWARE_VERSION_STRING,
        },
    });

    const aggregator = new Endpoint(AggregatorEndpoint, { id: "meters" });
    await node.add(aggregator);

    const meters = new Map<string, VirtualMeter>();

    const addMeter = async (meterConfig: MeterConfig): Promise<VirtualMeter> => {
        const existing = meters.get(meterConfig.id);
        if (existing !== undefined) return existing;

        // Der Zaehler wird vor dem Endpoint gebaut, damit die persistierten
        // Zaehlerstaende direkt als Initialwerte in die Cluster wandern.
        const meter = new VirtualMeter(meterConfig, store);
        // Beide Varianten tragen dieselben Messcluster - fuer alles, was danach
        // passiert, sind sie austauschbar, auch wenn die Typen sich unterscheiden.
        const endpointType = (
            meterConfig.kind === "plug" ? VirtualPlugEndpoint : VirtualMeterEndpoint
        ) as typeof VirtualMeterEndpoint;
        const endpoint = new Endpoint(endpointType, {
            id: meterConfig.id,
            bridgedDeviceBasicInformation: bridgedInfo(meterConfig, config),
            ...measurementDefaults(meter),
        });
        await aggregator.add(endpoint);
        meters.set(meterConfig.id, meter.attach(endpoint));
        return meter;
    };

    for (const meterConfig of config.meters) {
        await addMeter(meterConfig);
    }

    return {
        node,
        meters,
        addMeter,
        pairing(): PairingInfo {
            const commissioning = node.state.commissioning;
            return {
                commissioned: node.lifecycle.isCommissioned,
                fabrics: Object.keys(commissioning.fabrics ?? {}).length,
                manualPairingCode: commissioning.pairingCodes?.manualPairingCode,
                qrPairingCode: commissioning.pairingCodes?.qrPairingCode,
            };
        },
    };
}
