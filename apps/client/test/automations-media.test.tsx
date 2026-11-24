import {
  mediaFeatures,
  type CapabilityInfo,
  type DeviceInfo,
  type PieceInfo,
} from "@meetsanctum/app-sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  deviceCommandFor,
  deviceKindsFor,
  withDevice,
} from "../src/automations/chooser";
import { FieldControl } from "../src/automations/fields";
import {
  fieldKind,
  fieldsOf,
  formatValue,
  matchesCapability,
  plain,
  sentenceParts,
  type Names,
} from "../src/automations/words";
import { places } from "./automations-fixtures";

// Media players' steps in Automations: which players a step is offered for
// comes from the command it sends and what each player can do, as the core
// checks when it's saved, and a volume reads and is chosen in percent, with
// where the player is now.

const deviceStep: PieceInfo = {
  kind: "step",
  app: null,
  id: "device",
  title: "Command a device",
  icon: null,
  sentence: null,
  card: null,
  needs: [],
  group: null,
  presets: [
    {
      title: "Turn off",
      sentence: "Turn off {device}",
      config: { command: { on: false } },
    },
    {
      title: "Pause",
      sentence: "Pause {device}",
      config: { command: { activity: "paused" } },
    },
    {
      title: "Mute",
      sentence: "Mute {device}",
      config: { command: { muted: true } },
    },
  ],
  config: {
    type: "object",
    properties: {
      device: { type: "string", names: "device" },
      capability: { type: "string", partOf: "device" },
      command: { type: "object" },
    },
    required: ["device", "capability", "command"],
  },
};

const volumeStep: PieceInfo = {
  kind: "step",
  app: null,
  id: "volume",
  title: "Set a player's volume",
  icon: null,
  sentence: "Set {device}'s volume to {volume}",
  card: null,
  needs: [],
  group: null,
  presets: [{ title: "Set the volume", config: { volume: 30 } }],
  config: {
    type: "object",
    properties: {
      device: { type: "string", names: "device", sends: { volume: 0 } },
      capability: { type: "string", partOf: "device" },
      volume: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        percent: true,
        title: "Volume",
      },
    },
    required: ["device", "capability", "volume"],
  },
};

const part = (
  id: string,
  features: Partial<CapabilityInfo["features"]>,
  state: Record<string, unknown> | null = null,
) =>
  ({
    id,
    kind: "media",
    features: mediaFeatures.parse(features),
    state,
    observed: state,
    desired: null,
    sync: "synced",
    setBy: null,
    changedAt: null,
  }) as CapabilityInfo;

// A smart speaker with no power, a level and mute; a TV box with power,
// volume in steps and no mute.
const speaker = part(
  "speaker",
  { playback: ["play", "pause", "stop"], volume: "level", mute: true },
  { activity: "idle", volume: 45, muted: false },
);
const box = part("box", {
  power: true,
  playback: ["play", "pause", "stop", "next", "previous", "seek"],
  volume: "steps",
});
const lamp = { id: "light", kind: "light" } as CapabilityInfo;

const homeDevices = [
  {
    id: "office-speaker",
    name: "Office Speaker",
    roomId: "office",
    capabilities: [speaker],
  },
  {
    id: "living-box",
    name: "Living Room Box",
    roomId: "office",
    capabilities: [box],
  },
] as unknown as DeviceInfo[];

const names: Names = {
  room: () => undefined,
  floor: () => undefined,
  zone: () => undefined,
  device: (id) => {
    const device = homeDevices.find((each) => each.id === id);
    return device && { name: device.name, kinds: ["media"] };
  },
  entity: () => undefined,
  app: () => undefined,
};

// Whether a step's preset is offered for a part.
function offers(piece: PieceInfo, title: string, capability: CapabilityInfo) {
  const config = piece.presets.find((each) => each.title === title)!.config;
  return matchesCapability(
    capability,
    deviceKindsFor(piece, config),
    config.field,
    deviceCommandFor(piece, config),
  );
}

describe("a player's steps", () => {
  it("are for the kinds that take their command", () => {
    expect(
      deviceKindsFor(deviceStep, { command: { activity: "paused" } }),
    ).toEqual(["media"]);
    expect(deviceKindsFor(deviceStep, { command: { on: false } })).toEqual([
      "light",
      "switch",
      "media",
    ]);
    expect(deviceKindsFor(volumeStep, { volume: 30 })).toEqual(["media"]);
    // A step with no command yet stays with lights and switches.
    expect(deviceKindsFor(deviceStep, {})).toEqual(["light", "switch"]);
  });

  it("send the command their config holds, or their device field says", () => {
    expect(deviceCommandFor(deviceStep, { command: { muted: true } })).toEqual({
      muted: true,
    });
    expect(deviceCommandFor(volumeStep, { volume: 20 })).toEqual({
      volume: 20,
    });
    expect(deviceCommandFor(volumeStep, {})).toEqual({ volume: 0 });
  });

  it("are offered only for a player that can do them", () => {
    expect(offers(deviceStep, "Turn off", box)).toBe(true);
    expect(offers(deviceStep, "Turn off", speaker)).toBe(false);
    expect(offers(deviceStep, "Turn off", lamp)).toBe(true);
    expect(offers(deviceStep, "Pause", speaker)).toBe(true);
    expect(offers(deviceStep, "Pause", lamp)).toBe(false);
    expect(offers(deviceStep, "Mute", speaker)).toBe(true);
    expect(offers(deviceStep, "Mute", box)).toBe(false);
    expect(offers(volumeStep, "Set the volume", speaker)).toBe(true);
    // Its volume is only up and down.
    expect(offers(volumeStep, "Set the volume", box)).toBe(false);
  });

  it("name the part of a device that can do them", () => {
    expect(
      withDevice(
        deviceStep,
        { command: { muted: true } },
        { ...homeDevices[0]!, capabilities: [box, speaker] },
      ),
    ).toMatchObject({ device: "office-speaker", capability: "speaker" });
  });
});

describe("a player's volume", () => {
  const field = fieldsOf(volumeStep.config).volume!;

  it("reads in percent", () => {
    expect(fieldKind(field)).toEqual({ kind: "percent" });
    expect(formatValue(field, 30, names, "sentence")).toBe("30%");
    expect(
      plain(
        sentenceParts(
          volumeStep.sentence!,
          volumeStep,
          { device: "office-speaker", capability: "speaker", volume: 20 },
          names,
        ),
      ),
    ).toBe("Set Office Speaker's volume to 20%");
  });

  it("is chosen with a few levels, beside where the player is now", () => {
    const shown = (device: string) =>
      renderToStaticMarkup(
        <FieldControl
          name="volume"
          field={field}
          value={20}
          context={{
            home: { places, devices: homeDevices, entities: [] },
            config: {
              device,
              capability: device === "office-speaker" ? "speaker" : "box",
            },
          }}
          onChange={() => undefined}
        />,
      );

    const markup = shown("office-speaker");
    expect(markup).toContain("Volume");
    for (const level of ["10%", "20%", "30%", "50%", "75%"]) {
      expect(markup).toContain(level);
    }
    expect(markup).toContain("Office Speaker is at 45% now");
    // A player that says no level says nothing of where it is.
    expect(shown("living-box")).not.toContain("is at");
  });
});
