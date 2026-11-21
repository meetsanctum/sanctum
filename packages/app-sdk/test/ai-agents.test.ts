import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  aiAreas,
  assistantOfferOf,
  defineAction,
  defineApp,
  defineEntityType,
  forecastType,
  sunType,
  toStaticManifest,
  type AssistantOffer,
  type Tier,
} from "../src/index.js";

// What an app offers AI agents, and what defineApp refuses of it.

const action = (id: string, tier: Tier, assistant?: AssistantOffer) =>
  defineAction({
    id,
    title: "Tidy up",
    tier,
    input: z.object({}),
    output: z.object({}),
    assistant,
    run: async () => ({}),
  });

const app = (
  actions: ReturnType<typeof action>[],
  entities: ReturnType<typeof defineEntityType>[] = [],
) =>
  defineApp({
    id: "sanctum.example",
    name: "Example",
    version: "0.1.0",
    core: "^2.0.0",
    permissions: [],
    actions,
    events: [],
    provides: { entities },
  });

const offer = (needs?: string[]): AssistantOffer => ({
  starts: "on",
  description: "Tidy the home.",
  ...(needs ? { needs } : {}),
});

describe("an app's offers to AI agents", () => {
  it("may need the core's areas and the app's other offers", () => {
    expect(() =>
      app([
        action("example.tidy", "write", offer(["people.read", "example.look"])),
        action("example.look", "read", offer()),
      ]),
    ).not.toThrow();
  });

  it("refuses an action outside the everyday tiers", () => {
    expect(() => app([action("example.wipe", "destructive", offer())])).toThrow(
      /can't be offered to AI agents/,
    );
  });

  it("refuses a need that is nothing the core or the app has, or itself", () => {
    for (const need of ["workflows.manage", "example.tidy", "example.gone"]) {
      expect(
        () => app([action("example.tidy", "write", offer([need]))]),
        need,
      ).toThrow(/needs/);
    }
  });

  it("refuses an action and an entity type offered by one id", () => {
    const type = defineEntityType({
      id: "example.tidy",
      title: "Tidy",
      state: z.object({}),
      assistant: offer(),
    });
    expect(() =>
      app([action("example.tidy", "write", offer())], [type]),
    ).toThrow(/Duplicate offer to AI agents id/);
  });

  it("refuses circular prerequisites between offers", () => {
    expect(() =>
      app([
        action("example.tidy", "write", offer(["example.look"])),
        action("example.look", "read", offer(["example.tidy"])),
      ]),
    ).toThrow(/circular AI offer dependency/);
  });

  it("refuses a prerequisite that names both a core area and an offer", () => {
    expect(() =>
      app([
        action("example.tidy", "write", offer(["people.read"])),
        action("people.read", "read", offer()),
      ]),
    ).toThrow(/names both an area and an offer/);
  });

  it("starts the forecast on and the sun, which tells where the home is, off", () => {
    expect(forecastType.assistant?.starts).toBe("on");
    expect(sunType.assistant?.starts).toBe("off");
  });

  it("uses the standard type's offer in the manifest", () => {
    const manifest = toStaticManifest(
      app([], [{ ...sunType, assistant: offer() }]),
    );
    expect(manifest.provides.entities[0]?.assistant).toEqual(sunType.assistant);
  });
});

describe("the core's areas", () => {
  it("have no area to see lights by, and no sensor's own settings", () => {
    expect(aiAreas).toContain("devices.control:light");
    expect(aiAreas).not.toContain("devices.read:light");
    expect(
      aiAreas.filter((area) => area.startsWith("devices.control:")),
    ).toEqual(["devices.control:light", "devices.control:switch"]);
  });
});

describe("an offer read from a manifest", () => {
  it("reads an older SDK's expose, offered only where it is true", () => {
    expect(
      assistantOfferOf({ expose: true, description: "Follow the sun." }),
    ).toEqual({ starts: "on", description: "Follow the sun." });
    expect(
      assistantOfferOf({ expose: false, description: "Follow the sun." }),
    ).toBeNull();
    expect(assistantOfferOf(null)).toBeNull();
    expect(assistantOfferOf({ starts: "maybe", description: "x" })).toBeNull();
  });

  it("does not use expose as a fallback for an invalid offer", () => {
    expect(
      assistantOfferOf({
        starts: "off",
        expose: true,
        description: "Follow the sun.",
      }),
    ).toBeNull();
  });
});
