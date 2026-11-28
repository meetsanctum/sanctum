import {
  requestReplySchema,
  type Availability,
  type SpeechLanguage,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { ask, json, lit, overview } from "./request-support.js";

describe("the Assistant's whites and colours", () => {
  const light = (
    id: string,
    roomId: string,
    colorTemperature: { min: number; max: number } | null,
    availability: Availability = "online",
  ) => ({
    id: `device-${id}`,
    name: id,
    roomId,
    availability,
    capabilities: [
      {
        id: "light",
        kind: "light",
        features: { brightness: true, colorTemperature, color: true },
      },
    ],
  });
  const withWhites = {
    ...overview,
    rooms: [
      ...overview.rooms,
      { id: "room-attic", name: "Attic", floorId: "floor-top" },
    ],
    floors: [
      ...overview.floors,
      { id: "floor-top", name: "Top Floor", level: 1 },
    ],
    devices: [
      light("Desk", "room-office", { min: 153, max: 454 }),
      light("Shelf", "room-office", { min: 250, max: 454 }),
      light("Strip", "room-office", null),
      light("Pendant", "room-kitchen", { min: 100, max: 200 }),
      light("Skylight", "room-attic", { min: 300, max: 500 }),
    ],
  };
  const sets = async (text: string, language: SpeechLanguage = "en") =>
    (
      await ask(text, {
        language,
        tools: { home_overview: () => json(withWhites) },
      })
    ).calls.at(-1)?.input;

  it("sets the white a room's picker starts on, across every range its lights take", async () => {
    // Eight whites from 153 to 454 mireds; the picker starts on the fifth.
    expect(await sets("make the office white")).toEqual({
      place: { kind: "room", id: "room-office" },
      set: { colorTemperature: 325 },
    });
    expect(await sets("make the office bright white")).toEqual({
      place: { kind: "room", id: "room-office" },
      set: { colorTemperature: 325, brightness: 100 },
    });
    expect(await sets("make the lights on the ground floor bright")).toEqual({
      place: { kind: "floor", id: "floor-ground" },
      set: { colorTemperature: 302, brightness: 100 },
    });
    expect(await sets("make all the lights white")).toEqual({
      place: { kind: "home" },
      set: { colorTemperature: 329 },
    });
    expect(await sets("turn the skylight white")).toEqual({
      place: {
        kind: "lights",
        lights: [{ device: "device-Skylight", capability: "light" }],
      },
      set: { colorTemperature: 414 },
    });
  });

  it("sets warm and cool whites, any white where no light has whites, and the picker's colours", async () => {
    expect(await sets("set the office lights to warm white")).toMatchObject({
      set: { colorTemperature: 370 },
    });
    expect(await sets("make the kitchen cool white")).toMatchObject({
      set: { colorTemperature: 154 },
    });
    expect(await sets("turn the strip white")).toMatchObject({
      set: { colorTemperature: 250 },
    });
    expect(await sets("turn the kitchen lights blue")).toEqual({
      place: { kind: "room", id: "room-kitchen" },
      set: { hue: 220, saturation: 100 },
    });
    expect(await sets("mach das Licht im Office limettengrün", "de")).toEqual({
      place: { kind: "room", id: "room-office" },
      set: { hue: 76, saturation: 100 },
    });
  });

  it.each([
    ["online", 325],
    ["unknown", 325],
    ["offline", 437],
  ] as const)(
    "chooses the picker white with one %s light and one offline",
    async (availability, colorTemperature) => {
      const { calls } = await ask("make the office white", {
        tools: {
          home_overview: () =>
            json({
              ...overview,
              devices: [
                light(
                  "Desk",
                  "room-office",
                  { min: 153, max: 454 },
                  availability,
                ),
                light(
                  "Shelf",
                  "room-office",
                  { min: 450, max: 650 },
                  "offline",
                ),
              ],
            }),
        },
      });
      expect(calls.at(-1)).toEqual({
        name: "lights",
        input: {
          place: { kind: "room", id: "room-office" },
          set: { colorTemperature },
        },
      });
    },
  );

  const replyTo = async (
    text: string,
    lights: object[],
    language: SpeechLanguage = "en",
  ) =>
    (
      await ask(text, {
        language,
        tools: { lights: () => json({ change: "c1", lights }) },
      })
    ).replies;

  it("says the white or colour, and names the lights a colour can't reach", async () => {
    expect(await replyTo("make the office white", [lit("Desk Lamp")])).toEqual([
      { text: "Office lights white.", confirmation: true },
    ]);
    expect(await replyTo("make the office bright", [lit("Desk Lamp")])).toEqual(
      [{ text: "Office lights bright white.", confirmation: true }],
    );
    expect(
      await replyTo("make the office warm white", [
        lit("Desk Lamp"),
        lit("Shelf", "skipped", "unsupported"),
      ]),
    ).toEqual([{ text: "Office lights warm white.", confirmation: true }]);
    expect(
      await replyTo("make the office blue", [
        lit("Desk Lamp"),
        lit("Shelf", "skipped", "unsupported"),
        lit("Strip", "skipped", "unsupported"),
      ]),
    ).toEqual([
      {
        text: "Office lights blue. Shelf and Strip can't show colours.",
      },
    ]);
    expect(
      await replyTo("make the office red", [
        lit("Desk Lamp", "offline"),
        lit("Shelf", "skipped", "unsupported"),
      ]),
    ).toEqual([
      {
        text: "Office lights didn't answer. Shelf can't show colours.",
      },
    ]);
    expect(
      await replyTo("make the office green", [
        lit("Shelf", "skipped", "unsupported"),
      ]),
    ).toEqual([{ text: "No light in Office can show colours." }]);
    expect(
      await replyTo("make the desk lamp green", [
        lit("Desk Lamp", "skipped", "unsupported"),
      ]),
    ).toEqual([{ text: "Desk Lamp can't show colours." }]);
    expect(
      await replyTo("make all the lights cyan", [
        lit("Desk Lamp", "skipped", "unsupported"),
      ]),
    ).toEqual([{ text: "No light can show colours." }]);
  });

  it.each([
    ["en", "make all the lights blue", "didn't answer.", "can't show colours."],
    [
      "de",
      "mach alle Lichter blau",
      "antworten nicht.",
      "kann keine Farben zeigen.",
    ],
  ] as const)(
    "keeps both mixed colour notices within the reply limit in %s",
    async (language, request, missed, unsupported) => {
      const offline = Array.from({ length: 33 }, (_, index) =>
        lit(
          `Lamp ${index.toString().padStart(2, "0")} ${"x".repeat(110)}`,
          "offline",
        ),
      );
      const [reply] = await replyTo(
        request,
        [lit("Desk Lamp"), ...offline, lit("Shelf", "skipped", "unsupported")],
        language,
      );
      expect(reply?.text).toContain(missed);
      expect(reply?.text).toContain(unsupported);
      expect(requestReplySchema.safeParse(reply).success).toBe(true);
    },
  );

  it("answers in German", async () => {
    expect(
      await replyTo("mach das Licht blau", [lit("Desk Lamp")], "de"),
    ).toEqual([{ text: "Office: Licht blau.", confirmation: true }]);
    expect(
      await replyTo("mach das Licht hell", [lit("Desk Lamp")], "de"),
    ).toEqual([{ text: "Office: Licht hell.", confirmation: true }]);
    expect(
      await replyTo(
        "mach das Licht magenta",
        [lit("Desk Lamp"), lit("Shelf", "skipped", "unsupported")],
        "de",
      ),
    ).toEqual([
      {
        text: "Office: Licht magenta. Shelf kann keine Farben zeigen.",
      },
    ]);
    expect(
      await replyTo(
        "mach alle Lichter rot",
        [lit("Shelf", "skipped", "unsupported")],
        "de",
      ),
    ).toEqual([{ text: "Kein Licht kann Farben zeigen." }]);
  });
});
