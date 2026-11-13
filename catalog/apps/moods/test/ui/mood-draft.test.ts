import { describe, expect, it } from "vitest";

import {
  changes,
  draftTile,
  fillDraft,
  moodLightsOf,
  restoreLights,
  type DraftLight,
  type Mood,
} from "../../src/ui/mood-draft";
import { light } from "../moods/home";

const lamp = light(
  "lamp",
  {
    on: true,
    brightness: 30,
    colorMode: "color",
    hue: 220,
    saturation: 80,
  },
  { features: { color: true } },
);
const desk = light("desk", { on: false, brightness: 70 });

const relax: Mood = {
  id: "relax",
  roomId: "office",
  name: "Relax",
  icon: "palette",
  smart: null,
  lights: [
    {
      device: "lamp",
      capability: "light",
      state: { on: true, brightness: 30, hue: 220, saturation: 80 },
    },
  ],
};

const status = (drafted: DraftLight) => draftTile(desk, drafted).status;

describe("the mood editor's draft", () => {
  it("disables a drafted light when it goes offline without discarding its draft", () => {
    const offline = light("desk", { on: true, brightness: 70 });
    offline.device.availability = "offline";
    expect(
      draftTile(offline, { on: true, look: { brightness: 42 } }),
    ).toMatchObject({
      status: "Offline",
      disabled: true,
    });
  });

  it("shows custom explicit off as included but off", () => {
    const tile = draftTile(desk, { on: false, look: { brightness: 42 } });
    expect(tile).toMatchObject({ on: false, look: "off", status: "Off" });
  });

  it("shows custom draft brightness for included on lights", () => {
    expect(
      draftTile(desk, { on: true, look: { brightness: 42 } }),
    ).toMatchObject({
      on: true,
      look: "lit",
      status: "42%",
      brightness: 42,
      dims: true,
    });
  });

  it("shows custom draft color and color temperature state for included lights", () => {
    expect(
      status({ on: true, look: { brightness: 42, hue: 220, saturation: 80 } }),
    ).toBe("42% · Colour");
    expect(
      status({ on: true, look: { brightness: 42, colorTemperature: 370 } }),
    ).toBe("42% · 2703 K");
    expect(
      draftTile(
        light("plain", { on: true }, { features: { brightness: false } }),
        { on: true, look: {} },
      ).status,
    ).toBe("On");
  });

  it("starts a new mood from the lights as they are", () => {
    const draft = fillDraft(new Map(), [lamp, desk]);
    expect([...draft]).toEqual([
      [
        "lamp/light",
        { on: true, look: { brightness: 30, hue: 220, saturation: 80 } },
      ],
      // Off, at the level it comes back on at.
      ["desk/light", { on: false, look: { brightness: 70 } }],
    ]);
  });

  it("starts a saved mood as it sets the lights, those it leaves out off, and keeps what was drafted", () => {
    const draft = fillDraft(
      new Map([["desk/light", { on: true, look: { brightness: 10 } }]]),
      [lamp, desk],
      relax,
    );
    expect(draft.get("lamp/light")).toEqual({
      on: true,
      look: { brightness: 30, hue: 220, saturation: 80 },
    });
    expect(draft.get("desk/light")).toEqual({
      on: true,
      look: { brightness: 10 },
    });
    expect(fillDraft(new Map(), [desk], relax).get("desk/light")).toEqual({
      on: false,
      look: { brightness: 70 },
    });
  });

  it("matches unchanged custom mood editor drafts to their record", () => {
    const draft = fillDraft(new Map(), [lamp, desk], relax);
    const lights = moodLightsOf(draft, [lamp, desk], relax);
    expect(lights).toEqual([
      ...relax.lights,
      { device: "desk", capability: "light", state: { on: false } },
    ]);
    // A light the saved mood left out is off either way.
    expect(changes(relax, { name: "Relax ", icon: "palette", lights })).toBe(
      false,
    );
  });

  it("detects changed custom mood editor drafts", () => {
    const lights = relax.lights;
    expect(changes(relax, { name: "Rest", icon: "palette", lights })).toBe(
      true,
    );
    expect(changes(relax, { name: "Relax", icon: "moon", lights })).toBe(true);
    expect(
      changes(relax, {
        name: "Relax",
        icon: "palette",
        lights: [
          {
            device: "lamp",
            capability: "light",
            state: { on: true, brightness: 40, hue: 220, saturation: 80 },
          },
        ],
      }),
    ).toBe(true);
    expect(changes(undefined, { name: "Relax", icon: "palette", lights })).toBe(
      true,
    );
  });

  it("preserves selected existing actions hidden from editable light options", () => {
    const hidden = {
      device: "hidden",
      capability: "light",
      state: { on: true, brightness: 55 },
    } as const;
    const mood = { ...relax, lights: [...relax.lights, hidden] };
    const offline = light("hidden", { on: false }, {});
    offline.device.availability = "offline";
    const draft = fillDraft(
      new Map([["desk/light", { on: true, look: { brightness: 70 } }]]),
      [desk, offline],
      mood,
    );
    expect(draft.has("hidden/light")).toBe(false);
    expect(draftTile(offline, draft.get("hidden/light"))).toMatchObject({
      status: "Offline",
      disabled: true,
    });
    expect(moodLightsOf(draft, [desk, offline], mood)).toEqual([
      {
        device: "desk",
        capability: "light",
        state: { on: true, brightness: 70 },
      },
      ...mood.lights,
    ]);
  });

  it("puts back each light as it was when the preview began", () => {
    const first = restoreLights([lamp]);
    expect(first).toEqual([
      {
        device: "lamp",
        capability: "light",
        state: { on: true, brightness: 30, hue: 220, saturation: 80 },
      },
    ]);
    const changedLamp = light("lamp", { on: false, brightness: 30 });
    expect(restoreLights([changedLamp, desk], first)).toEqual([
      ...first,
      {
        device: "desk",
        capability: "light",
        state: { on: false, brightness: 70 },
      },
    ]);
  });

  it("puts a light that was off back off, coming back at its level and colour", () => {
    // Off at 70% in amber, which a preview may turn on in blue at 40%.
    const bulb = light(
      "bulb",
      {
        on: false,
        brightness: 70,
        colorMode: "color",
        hue: 30,
        saturation: 60,
      },
      { features: { color: true } },
    );
    const unknown = light("unknown", null);
    expect(restoreLights([bulb, unknown])).toEqual([
      {
        device: "bulb",
        capability: "light",
        state: { on: false, brightness: 70, hue: 30, saturation: 60 },
      },
      { device: "unknown", capability: "light", state: { on: false } },
    ]);
  });
});
