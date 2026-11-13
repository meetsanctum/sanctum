import { describe, expect, it } from "vitest";

import { deviceEntries } from "../src/devices.js";
import {
  actionExpose,
  lightExpose,
  switchExpose,
  zigbeeDevice,
} from "./pretend-bridge.js";

// Zigbee2MQTT's device list onto what the driver registers.

const lamp = zigbeeDevice("0x00124b0001abcd", "desk_lamp", [
  lightExpose({ colorTemperature: [200, 454], color: "color_hs" }),
]);

describe("the device list", () => {
  it("registers each light and switch by its IEEE address", () => {
    const [entry] = deviceEntries([lamp]);

    expect(entry).toMatchObject({
      key: "0x00124b0001abcd",
      friendlyName: "desk_lamp",
      battery: false,
      registration: {
        key: "0x00124b0001abcd",
        name: "desk_lamp",
        manufacturer: "Test Vendor",
        model: "TL-1",
        capabilities: [
          {
            id: "light",
            kind: "light",
            features: {
              brightness: true,
              colorTemperature: { min: 200, max: 454 },
              color: true,
            },
          },
        ],
      },
    });
  });

  it("registers a remote with its buttons' presses", () => {
    // An office button, as Zigbee2MQTT lists it.
    const [entry] = deviceEntries([
      zigbeeDevice(
        "0x00158d0003c4d5e6",
        "0x00158d0003c4d5e6",
        [
          actionExpose([
            "single",
            "double",
            "triple",
            "quadruple",
            "hold",
            "release",
          ]),
          { type: "numeric", property: "battery", unit: "%", access: 5 },
        ],
        {
          type: "EndDevice",
          power_source: "Battery",
          manufacturer: "LUMI",
          definition: {
            vendor: "Aqara",
            model: "WXKG11LM",
            description: "Wireless mini switch",
            exposes: [
              actionExpose([
                "single",
                "double",
                "triple",
                "quadruple",
                "hold",
                "release",
              ]),
            ],
          },
        },
      ),
    ]);

    expect(entry).toMatchObject({
      battery: true,
      registration: {
        key: "0x00158d0003c4d5e6",
        name: "Wireless mini switch",
        manufacturer: "Aqara",
        model: "WXKG11LM",
        capabilities: [
          {
            id: "button",
            kind: "button",
            features: {
              actions: ["single", "double", "triple", "quadruple", "hold"],
            },
          },
        ],
      },
    });
  });

  it("brings a device that exposes nothing the core has a capability for, with none", () => {
    // A door sensor, and a repeater that exposes only its link quality.
    const entries = deviceEntries([
      zigbeeDevice("0x02", "door", [{ type: "binary", property: "contact" }], {
        power_source: "Battery",
      }),
      zigbeeDevice("0x0b", "0x0b", [
        { type: "numeric", property: "linkquality", access: 1 },
      ]),
    ]);
    expect(entries).toMatchObject([
      {
        key: "0x02",
        friendlyName: "door",
        battery: true,
        capabilities: [],
        registration: {
          key: "0x02",
          name: "door",
          manufacturer: "Test Vendor",
          model: "TL-1",
          // Nothing says what it is, and nothing of it can be read.
          type: null,
          capabilities: [],
          firmware: { updatable: false, sleeps: true },
          probe: false,
        },
      },
      {
        key: "0x0b",
        // Named by what it is, while nobody renamed it in Zigbee2MQTT.
        registration: { name: "Test light", capabilities: [], probe: false },
      },
    ]);
  });

  it("leaves out the coordinator and disabled and nameless devices", () => {
    expect(
      deviceEntries([
        {
          type: "Coordinator",
          ieee_address: "coordinator",
          friendly_name: "Coordinator",
        },
        zigbeeDevice("0x01", "off_list", [switchExpose()], { disabled: true }),
        zigbeeDevice("0x03", "nameless", [switchExpose()], {
          friendly_name: undefined,
        }),
        "not a device",
        null,
      ]),
    ).toEqual([]);
    expect(deviceEntries({ devices: [lamp] })).toEqual([]);
  });

  it("waits until a device's interview has succeeded", () => {
    const joining = zigbeeDevice("0x04", "0x04", [switchExpose()], {
      interview_completed: false,
      interviewing: true,
      interview_state: "IN_PROGRESS",
    });
    // Ghost devices: unsupported and failed to interview.
    const ghost = zigbeeDevice("0x05", "0x05", [switchExpose()], {
      supported: false,
      interview_completed: false,
      interview_state: "FAILED",
    });

    expect(deviceEntries([joining, ghost])).toEqual([]);
    expect(
      deviceEntries([
        {
          ...joining,
          interview_completed: undefined,
          interview_state: "SUCCESSFUL",
        },
      ]),
    ).toHaveLength(1);
  });

  it("names a device Zigbee2MQTT still calls by its address after what it is", () => {
    const named = (device: Parameters<typeof zigbeeDevice>[3]) =>
      deviceEntries([
        zigbeeDevice("0x00158d0001", "0x00158d0001", [switchExpose()], device),
      ])[0]?.registration.name;

    expect(named({})).toBe("Test light");
    expect(
      named({
        definition: {
          vendor: "IKEA",
          model: "E1603",
          exposes: [switchExpose()],
        },
      }),
    ).toBe("IKEA E1603");
    expect(named({ definition: { exposes: [switchExpose()] } })).toBe(
      "0x00158d0001",
    );
  });

  it("keeps labels the core takes", () => {
    const [entry] = deviceEntries([
      zigbeeDevice("0x06", `  ${"long ".repeat(40)}`, [switchExpose()], {
        definition: { vendor: "  ", exposes: [switchExpose()] },
        manufacturer: "Acme",
        model_id: undefined,
      }),
    ]);

    expect(entry?.registration.name).toHaveLength(119);
    expect(entry?.registration.manufacturer).toBe("Acme");
    expect(entry?.registration.model).toBeNull();
  });

  it("says a switch is a plug when its name or model does, and nothing of the rest", () => {
    const outlet = (extra: Parameters<typeof zigbeeDevice>[3] = {}) =>
      zigbeeDevice("0x08", "0x08", [switchExpose()], {
        definition: {
          vendor: "IKEA",
          model: "E1603",
          description: "TRADFRI control outlet",
          exposes: [switchExpose()],
        },
        ...extra,
      });
    const typeOf = (device: ReturnType<typeof zigbeeDevice>) =>
      deviceEntries([device])[0]?.registration.type;

    // Named by what it is, while nobody renamed it in Zigbee2MQTT.
    expect(typeOf(outlet())).toBe("plug");
    // By its model, under a name that says nothing.
    expect(
      typeOf(
        outlet({
          friendly_name: "kettle",
          definition: {
            vendor: "Test Vendor",
            model: "Smart socket S1",
            description: "Relay",
            exposes: [switchExpose()],
          },
        }),
      ),
    ).toBe("plug");
    // Only a whole word says so, and only of a switch.
    expect(typeOf(outlet({ friendly_name: "remote_plug" }))).toBeNull();
    expect(typeOf(zigbeeDevice("0x09", "0x09", [switchExpose()]))).toBeNull();
    expect(
      typeOf(
        zigbeeDevice("0x0a", "0x0a", [lightExpose()], {
          definition: {
            vendor: "Test Vendor",
            model: "TL-1",
            description: "Plug-in light",
            exposes: [lightExpose()],
          },
        }),
      ),
    ).toBeNull();
  });

  it("knows a battery-powered device", () => {
    const [entry] = deviceEntries([
      zigbeeDevice("0x07", "remote_plug", [switchExpose()], {
        power_source: "Battery",
      }),
    ]);
    expect(entry?.battery).toBe(true);
  });

  it("lists each device once", () => {
    expect(deviceEntries([lamp, lamp])).toHaveLength(1);
  });
});
