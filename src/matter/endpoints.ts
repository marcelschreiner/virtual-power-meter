/**
 * Endpoint-Typen fuer die virtuellen Zaehler.
 *
 * Beide Varianten tragen dieselben Messcluster:
 *   ElectricalPowerMeasurement  (Momentanwerte: Leistung, Spannung, Strom)
 *   ElectricalEnergyMeasurement (kumulierte Energie, Bezug und Einspeisung)
 *
 * Unterschied ist nur der Geraetetyp, unter dem die Werte im Ecosystem landen.
 */
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { ElectricalEnergyMeasurementServer } from "@matter/main/behaviors/electrical-energy-measurement";
import { ElectricalPowerMeasurementServer } from "@matter/main/behaviors/electrical-power-measurement";
import { PowerTopologyServer } from "@matter/main/behaviors/power-topology";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
import { ElectricalSensorEndpoint } from "@matter/main/endpoints/electrical-sensor";

/** Wechselstrom-Messung: Wirkleistung, Spannung und Strom. */
export const PowerMeasurementServer = ElectricalPowerMeasurementServer.with("AlternatingCurrent");

/** Kumulierte Energie in beide Richtungen (Bezug und Einspeisung). */
export const EnergyMeasurementServer = ElectricalEnergyMeasurementServer.with(
    "ImportedEnergy",
    "ExportedEnergy",
    "CumulativeEnergy",
);

/** PowerTopology: der Zaehler misst den gesamten Strom des Knotens. */
export const TopologyServer = PowerTopologyServer.with("NodeTopology");

/**
 * Electrical Sensor (Matter-Geraetetyp 0x0510). Der spezifikationskonforme
 * Zaehler - Home Assistant legt daraus Leistungs- und Energie-Sensoren an.
 */
export const VirtualMeterEndpoint = ElectricalSensorEndpoint.with(
    BridgedDeviceBasicInformationServer,
    TopologyServer,
    PowerMeasurementServer,
    EnergyMeasurementServer,
);

/**
 * On/Off Plug-in Unit (0x010A) mit denselben Messclustern. Electrical Sensor ist
 * ein Utility-Geraetetyp, den manche Ecosysteme gar nicht anzeigen; als Steckdose
 * taucht der Zaehler dagegen ueberall auf - inklusive eines Schalters, der hier
 * nichts weiter tut, als seinen Zustand zu merken.
 */
export const VirtualPlugEndpoint = OnOffPlugInUnitDevice.with(
    BridgedDeviceBasicInformationServer,
    TopologyServer,
    PowerMeasurementServer,
    EnergyMeasurementServer,
);
