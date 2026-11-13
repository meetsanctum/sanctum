import { describe, expect, it } from "vitest";

import {
  activeMood,
  captureLight,
  moodCommands,
  showsState,
  type MoodLight,
} from "../../src/moods/light-states.js";
import { light, lightCapability } from "./home.js";

// What a mood does with a room's lights.

const at = (device: string, state: MoodLight["state"]): MoodLight => ({
  device,
  capability: "light",
  state,
});

describe("moodCommands", () => {
  it("turns off non-mood lights when building target mood commands", () => {
    const moodLight = light("mood-light", { on: true, brightness: 50 });
    const extraLight = light("extra-light", { on: true, brightness: 50 });

    const commands = moodCommands(
      [
        at("mood-light", { on: true, brightness: 72 }),
        at("out-of-target-light", { on: true, brightness: 20 }),
      ],
      [moodLight, extraLight],
    );

    expect(commands).toEqual([
      { light: moodLight, command: { on: true, brightness: 72 } },
      { light: extraLight, command: { on: false } },
    ]);
  });

  it("sets each light's whole state, off included, and leaves other lights that are off alone", () => {
    const lamp = light("lamp", { on: false, brightness: 70 });
    const ceiling = light("ceiling", { on: true, brightness: 30 });
    const spare = light("spare", { on: false, brightness: 10 });

    expect(
      moodCommands(
        [
          at("lamp", { on: true, brightness: 40, colorTemperature: 370 }),
          at("ceiling", { on: false }),
        ],
        [lamp, ceiling, spare],
      ).map(({ light, command }) => [light.device.id, command]),
    ).toEqual([
      ["lamp", { on: true, brightness: 40, colorTemperature: 370 }],
      ["ceiling", { on: false }],
    ]);
  });

  it("does nothing when none of the mood's lights is in the room", () => {
    expect(
      moodCommands(
        [at("elsewhere", { on: true, brightness: 50 })],
        [light("lamp", { on: true, brightness: 50 })],
      ),
    ).toEqual([]);
  });
});

describe("captureLight", () => {
  it("keeps an off light off", () => {
    expect(
      captureLight(lightCapability({ on: false, brightness: 60 })),
    ).toEqual({ on: false });
    expect(captureLight(lightCapability(null))).toEqual({ on: false });
  });

  it("keeps the level and the colour or colour temperature the light shows", () => {
    const colour = { brightness: true, color: true };
    const temperature = { colorTemperature: { min: 153, max: 500 } };
    expect(
      captureLight(
        lightCapability(
          {
            on: true,
            brightness: 64,
            colorMode: "color",
            hue: 215,
            saturation: 72,
            colorTemperature: 300,
          },
          { features: { ...colour, ...temperature } },
        ),
      ),
    ).toEqual({ on: true, brightness: 64, hue: 215, saturation: 72 });
    expect(
      captureLight(
        lightCapability(
          {
            on: true,
            brightness: 40,
            colorMode: "temperature",
            colorTemperature: 370,
            hue: 30,
            saturation: 50,
          },
          { features: { ...colour, ...temperature } },
        ),
      ),
    ).toEqual({ on: true, brightness: 40, colorTemperature: 370 });
  });

  it("keeps only what the light can do", () => {
    expect(
      captureLight(
        lightCapability(
          { on: true, brightness: 100, colorTemperature: 300 },
          { features: { brightness: false } },
        ),
      ),
    ).toEqual({ on: true });
  });

  it("counts a command still on its way, as the light's state shows it", () => {
    expect(
      captureLight(
        lightCapability(
          { on: true, brightness: 80 },
          { sync: "pending", desired: { brightness: 80 } },
        ),
      ),
    ).toEqual({ on: true, brightness: 80 });
  });
});

describe("activeMood", () => {
  const relax = {
    id: "relax",
    lights: [at("office-light", { on: true, brightness: 80 })],
  };

  it("marks saved room moods active when their light expectations match", () => {
    expect(
      activeMood(
        [relax],
        [light("office-light", { on: true, brightness: 80 })],
      ),
    ).toBe("relax");
  });

  it("resolves active saved moods from pending target state", () => {
    // The core shows a command on its way in the light's state.
    expect(
      activeMood(
        [relax],
        [
          light(
            "office-light",
            { on: true, brightness: 80 },
            { sync: "pending", desired: { brightness: 80 } },
          ),
        ],
      ),
    ).toBe("relax");
  });

  it("does not mark any saved mood active when multiple moods match", () => {
    expect(
      activeMood(
        [relax, { ...relax, id: "work" }],
        [light("office-light", { on: true, brightness: 80 })],
      ),
    ).toBeNull();
  });

  it("does not mark a mood active when another light in the room is on", () => {
    expect(
      activeMood(
        [relax],
        [
          light("office-light", { on: true, brightness: 80 }),
          light("extra-light", { on: true, brightness: 50 }),
        ],
      ),
    ).toBeNull();
  });

  it("matches within the tolerances, with hue going round", () => {
    const wanted = {
      on: true,
      brightness: 50,
      hue: 359,
      saturation: 80,
    } as const;
    expect(
      showsState({ on: true, brightness: 52, hue: 1, saturation: 78 }, wanted),
    ).toBe(true);
    expect(
      showsState(
        { on: true, brightness: 53, hue: 359, saturation: 80 },
        wanted,
      ),
    ).toBe(false);
    expect(
      showsState(
        { on: true, colorTemperature: 385 },
        { on: true, colorTemperature: 370 },
      ),
    ).toBe(true);
    expect(
      showsState(
        { on: true, colorTemperature: 386 },
        { on: true, colorTemperature: 370 },
      ),
    ).toBe(false);
    expect(showsState(null, { on: false })).toBe(false);
  });

  it("does not match remembered colour values from the inactive mode", () => {
    const state = {
      on: true,
      hue: 220,
      saturation: 80,
      colorTemperature: 370,
    };
    expect(
      showsState(
        { ...state, colorMode: "temperature" },
        { on: true, hue: 220, saturation: 80 },
      ),
    ).toBe(false);
    expect(
      showsState(
        { ...state, colorMode: "color" },
        { on: true, colorTemperature: 370 },
      ),
    ).toBe(false);
  });
});
