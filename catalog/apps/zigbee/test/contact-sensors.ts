import type { ZigbeeDevice, ZigbeeExpose } from "../src/types.js";
import { zigbeeDevice } from "./pretend-bridge.js";

// Contact sensors as Zigbee2MQTT describes them: Aqara's door and window
// sensor (MCCGQ11LM), with its charge in percent, and SONOFF's (SNZB-04),
// which also says battery_low. Each publishes its contact and cannot be
// asked for it, on its battery.

const reading = (property: string, unit: string): ZigbeeExpose => ({
  type: "numeric",
  name: property,
  property,
  unit,
  access: 1,
});

/** The contact as Zigbee2MQTT exposes it: on, an open contact, is false. */
export const contactExpose: ZigbeeExpose = {
  type: "binary",
  name: "contact",
  property: "contact",
  value_on: false,
  value_off: true,
  access: 1,
};

const flag = (property: string): ZigbeeExpose => ({
  type: "binary",
  name: property,
  property,
  value_on: true,
  value_off: false,
  access: 1,
});

function sensor(
  key: string,
  name: string,
  definition: { vendor: string; model: string; description: string },
  exposes: ZigbeeExpose[],
  modelId: string,
): ZigbeeDevice {
  return zigbeeDevice(key, name, exposes, {
    type: "EndDevice",
    power_source: "Battery",
    model_id: modelId,
    definition: { ...definition, exposes },
  });
}

/** Aqara's door and window sensor, MCCGQ11LM. */
export function aqaraContactSensor(key: string, name: string) {
  return sensor(
    key,
    name,
    {
      vendor: "Aqara",
      model: "MCCGQ11LM",
      description: "Door and window sensor",
    },
    [
      reading("battery", "%"),
      contactExpose,
      reading("device_temperature", "°C"),
      reading("voltage", "mV"),
      reading("power_outage_count", ""),
      reading("trigger_count", ""),
      reading("linkquality", "lqi"),
    ],
    "lumi.sensor_magnet.aq2",
  );
}

/** SONOFF's contact sensor, SNZB-04, which says battery_low beside its charge. */
export function sonoffContactSensor(key: string, name: string) {
  return sensor(
    key,
    name,
    { vendor: "SONOFF", model: "SNZB-04", description: "Contact sensor" },
    [
      reading("battery", "%"),
      reading("voltage", "mV"),
      contactExpose,
      flag("battery_low"),
      reading("linkquality", "lqi"),
    ],
    "DS01",
  );
}

/** The flags a sensor on an alarm zone says beside its contact. */
export const zoneFlags = [flag("battery_low"), flag("tamper")];
