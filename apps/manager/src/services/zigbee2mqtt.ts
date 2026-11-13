import type { ServiceSpec } from "./containers.js";
import { stacked } from "../stack.js";
import { mosquittoUrl } from "./mosquitto.js";
import type { ZigbeeCoordinator } from "./zigbee-coordinator.js";

// The Zigbee bridge, for the Zigbee driver app. Zigbee2MQTT keeps its own
// configuration.yaml in its data volume, where it writes the network key it
// generates on first start, and the manager sets what it owns through
// ZIGBEE2MQTT_CONFIG_* variables, which Zigbee2MQTT applies (and saves) on
// every start.

export const zigbee2mqttImage = "ghcr.io/koenkk/zigbee2mqtt:2.14.2";
export const zigbee2mqttBaseTopic = "zigbee2mqtt";
const dataVolume = stacked("sanctum-zigbee2mqtt-data");
// Where the coordinator appears inside the container, whatever its host path.
const devicePath = "/dev/zigbee";

export function zigbee2mqttSpec(options: {
  coordinator: ZigbeeCoordinator;
  mqtt: { username: string; password: string };
}): ServiceSpec {
  const { serial } = options.coordinator;
  const config: Record<string, string> = {
    MQTT_SERVER: mosquittoUrl,
    MQTT_BASE_TOPIC: zigbee2mqttBaseTopic,
    MQTT_USER: options.mqtt.username,
    // Zigbee2MQTT needs the password itself; only root on the host can read a
    // container's environment, as it can read the broker's data.
    MQTT_PASSWORD: options.mqtt.password,
    SERIAL_PORT: devicePath,
    SERIAL_ADAPTER: serial.adapter,
    // Saved settings outlive the variables that set them, so serial settings
    // are always given in full: a profile's, or zigbee-herdsman's defaults.
    SERIAL_BAUDRATE: String(
      serial.baudRate ?? (serial.adapter === "deconz" ? 38_400 : 115_200),
    ),
    SERIAL_RTSCTS: String(serial.rtscts ?? false),
    FRONTEND_ENABLED: "false",
    HOMEASSISTANT_ENABLED: "false",
    AVAILABILITY_ENABLED: "true",
    ADVANCED_LAST_SEEN: "ISO_8601",
    // Docker keeps the logs; files would wear the SD card.
    ADVANCED_LOG_OUTPUT: '["console"]',
    // Zigbee2MQTT recommends this for ConBee/RaspBee adapters when APS
    // requests are unstable.
    ADVANCED_ADAPTER_DELAY: serial.adapter === "deconz" ? "200" : "0",
  };
  return {
    image: zigbee2mqttImage,
    env: [
      // A new install would otherwise wait for setup in Zigbee2MQTT's own UI.
      "Z2M_ONBOARD_NO_SERVER=1",
      ...Object.entries(config).map(
        ([key, value]) => `ZIGBEE2MQTT_CONFIG_${key}=${value}`,
      ),
    ],
    volumes: [{ name: dataVolume, target: "/app/data" }],
    // Docker resolves a /dev/serial/by-id link each time the container
    // starts, so a coordinator that comes back as another tty still works.
    devices: [{ host: options.coordinator.path, container: devicePath }],
  };
}
