// What Zigbee2MQTT publishes, as far as the driver reads it. Everything
// arrives over MQTT, so every field is checked before use.

/** One of a device's exposes, as Zigbee2MQTT describes what it can do. */
export type ZigbeeExpose = {
  type?: string;
  name?: string;
  property?: string;
  endpoint?: string;
  /** Bits: 1 published in its state, 2 settable, 4 readable with /get. */
  access?: number;
  unit?: string;
  value_min?: number;
  value_max?: number;
  value_on?: unknown;
  value_off?: unknown;
  values?: unknown[];
  features?: ZigbeeExpose[];
};

/** One entry of `bridge/devices`. */
export type ZigbeeDevice = {
  ieee_address?: string;
  friendly_name?: string;
  type?: string;
  disabled?: boolean;
  supported?: boolean;
  interview_completed?: boolean;
  interview_state?: string;
  interviewing?: boolean;
  manufacturer?: string;
  model_id?: string;
  power_source?: string;
  software_build_id?: string;
  date_code?: string;
  definition?: {
    model?: string;
    vendor?: string;
    description?: string;
    exposes?: ZigbeeExpose[];
    /** Whether Zigbee2MQTT can update its firmware over the air. */
    supports_ota?: boolean;
  } | null;
};

/** One message as the broker delivered it. */
export type ZigbeeMessage = {
  topic: string;
  payload: Buffer;
  /** Sent because it was kept on the broker, not because it just happened. */
  retained: boolean;
};

export const defaultBaseTopic = "zigbee2mqtt";

// Zigbee2MQTT's access bits.
export const access = { state: 1, set: 2, get: 4 } as const;
