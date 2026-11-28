import { describe, expect, it } from "vitest";

import { ask, json, mood, moods, overview } from "./request-support.js";

describe("the Assistant's moods", () => {
  it("runs a mood in the speaker's room, reading the moods only for it", async () => {
    const { calls, replies } = await ask("set the mood to evening");
    expect(calls).toEqual([
      { name: "home_overview", input: {} },
      { name: "entities", input: { type: "mood" } },
      { name: "run", input: { app: "sanctum.moods", key: "office-evening" } },
    ]);
    expect(replies).toEqual([
      { text: "Evening in Office.", confirmation: true },
    ]);
  });

  it("runs a mood in the room named, or the one room that has it", async () => {
    const ran = async (text: string, options = {}) =>
      (await ask(text, options)).calls.find(({ name }) => name === "run")
        ?.input;
    expect(await ran("Evening in the kitchen")).toEqual({
      app: "sanctum.moods",
      key: "kitchen-evening",
    });
    // Asked from the Office, but only the Kitchen has Dinner.
    expect(await ran("turn on dinner")).toEqual({
      app: "sanctum.moods",
      key: "kitchen-dinner",
    });
    expect(await ran("turn on dinner", { from: "client" })).toEqual({
      app: "sanctum.moods",
      key: "kitchen-dinner",
    });
  });

  it.each([
    [
      "en",
      "set the Office to blue",
      "Office",
      "Blue",
      "Did you mean to change the lights or start a mood?",
    ],
    [
      "de",
      "stell das Büro auf blau",
      "Büro",
      "Blau",
      "Möchtest du das Licht ändern oder eine Stimmung starten?",
    ],
  ] as const)(
    "asks before changing a light when the same request names a mood in %s",
    async (language, text, name, colour, question) => {
      const { calls, replies } = await ask(text, {
        language,
        tools: {
          home_overview: () =>
            json({
              ...overview,
              rooms: overview.rooms.map((room) =>
                room.id === "room-office" ? { ...room, name } : room,
              ),
              devices: [
                { ...overview.devices[0], name, roomId: "room-kitchen" },
              ],
            }),
          entities: () =>
            json({ entities: [mood("office-blue", colour, "room-office")] }),
        },
      });
      expect(calls.map(({ name }) => name)).toEqual([
        "home_overview",
        "entities",
      ]);
      expect(replies).toEqual([{ text: expect.stringContaining(question) }]);
    },
  );

  it("sets a named light's colour when the mood is in a different room", async () => {
    const { calls } = await ask("set the Office to blue", {
      tools: {
        home_overview: () =>
          json({
            ...overview,
            devices: [
              {
                ...overview.devices[0],
                name: "Office",
                roomId: "room-kitchen",
              },
            ],
          }),
        entities: () =>
          json({ entities: [mood("kitchen-blue", "Blue", "room-kitchen")] }),
      },
    });
    expect(calls.map(({ name }) => name)).toEqual([
      "home_overview",
      "entities",
      "lights",
    ]);
  });

  it("asks which room, or says there's no such mood there", async () => {
    const whichRoom =
      "Which room? Several have a mood called Evening. Say the room too.";
    const typed = await ask("turn on evening", { from: "client" });
    expect(typed.replies).toEqual([{ text: whichRoom }]);
    expect(typed.calls.map(({ name }) => name)).not.toContain("run");
    const speaker = await ask("turn on evening", {
      room: { id: "room-loft", name: "Loft" },
    });
    expect(speaker.replies).toEqual([{ text: whichRoom }]);
    expect(speaker.calls.map(({ name }) => name)).not.toContain("run");
    const wrongRoom = await ask("set the office to dinner");
    expect(wrongRoom.replies).toEqual([
      { text: "Office has no mood called Dinner." },
    ]);
    expect(wrongRoom.calls.map(({ name }) => name)).not.toContain("run");
  });

  it("asks which room when more than one has the requested room name", async () => {
    const { calls, replies } = await ask("Evening in the Office", {
      tools: {
        home_overview: () =>
          json({
            ...overview,
            rooms: [
              ...overview.rooms,
              { id: "second-office", name: "Office", floorId: null },
            ],
          }),
      },
    });
    expect(replies).toEqual([
      { text: "Which room? More than one is named Office." },
    ]);
    expect(calls.map(({ name }) => name)).not.toContain("run");
  });

  it.each(["Evening in the Office", "set the mood to Evening"])(
    "reports duplicate mood names in one room for %s",
    async (text) => {
      const { calls, replies } = await ask(text, {
        from: "client",
        tools: {
          entities: () =>
            json({
              entities: [
                moods[0],
                {
                  ...mood("desk-evening", "Evening", "room-office"),
                  app: "sanctum.example",
                },
              ],
            }),
        },
      });
      expect(replies).toEqual([
        { text: "More than one mood in Office is called Evening." },
      ]);
      expect(calls.map(({ name }) => name)).not.toContain("run");
    },
  );

  it.each([
    [
      "limited",
      "Too many calls to your home's tools just now. Try again in a minute.",
      "Too many calls to your home's tools just now. Try again in a minute.",
    ],
    [
      "not_allowed",
      "Nothing apps bring is switched on for AI agents.",
      "I can only help with lights and moods.",
    ],
  ])("handles a mood lookup that returns %s", async (error, toolText, text) => {
    const { calls, replies } = await ask("set the mood to evening", {
      tools: { entities: () => ({ text: toolText, isError: true, error }) },
    });
    expect(replies).toEqual([{ text }]);
    expect(calls.map(({ name }) => name)).not.toContain("run");
  });

  it("names the lights a mood couldn't reach", async () => {
    const { replies } = await ask("set the mood to evening", {
      tools: {
        run: () =>
          json({
            type: "mood",
            result: {
              switched: 1,
              failed: [{ device: "device-desk", capability: "light" }],
            },
          }),
      },
    });
    expect(replies).toEqual([
      { text: "Evening in Office. Desk Lamp didn't answer." },
    ]);
  });

  it.each([
    [[], "Nothing changed."],
    [
      [{ device: "device-desk", capability: "light" }],
      "Nothing changed. Desk Lamp didn't answer.",
    ],
  ])(
    "reports no change when a mood sets no lights (%j)",
    async (failed, text) => {
      const { replies } = await ask("set the mood to evening", {
        tools: {
          run: () => json({ type: "mood", result: { switched: 0, failed } }),
        },
      });
      expect(replies).toEqual([{ text }]);
    },
  );

  it("says where running moods is switched on when it isn't allowed", async () => {
    const refused = {
      run: () => ({
        text: "“Run a mood” is switched off for AI agents in Moods' settings.",
        isError: true,
        error: "not_allowed",
      }),
    };
    expect(
      (await ask("set the mood to evening", { tools: refused })).replies,
    ).toEqual([
      {
        text: "“Run a mood” is switched off for AI agents in Moods' settings.",
      },
    ]);
  });

  it.each([
    [
      "not_allowed",
      "“Run a mood” is switched off for AI agents in Moods' settings.",
      "Ich darf diese Stimmung nicht starten. Das lässt sich in den Einstellungen von Moods einschalten.",
    ],
    [
      "not_allowed",
      "“Run a mood” needs “Control your lights”, which is switched off for AI agents in Settings, What AI Agents Can Use.",
      "Ich darf diese Stimmung nicht starten. Das lässt sich unter Settings, What AI Agents Can Use einschalten.",
    ],
    [
      "timeout",
      "The app didn't answer in time.",
      "Die App hat nicht rechtzeitig geantwortet.",
    ],
  ])(
    "says in German why a mood didn't run (%s)",
    async (error, toolText, text) => {
      const { replies } = await ask("stell die Stimmung auf Abend", {
        language: "de",
        tools: {
          run: () => ({ text: toolText, isError: true, error }),
          entities: () =>
            json({ entities: [mood("office-abend", "Abend", "room-office")] }),
        },
      });
      expect(replies).toEqual([{ text }]);
    },
  );

  it("answers in German", async () => {
    const { replies } = await ask("Stell das Büro auf Abend", {
      language: "de",
      tools: {
        home_overview: () =>
          json({
            ...overview,
            rooms: [{ id: "room-office", name: "Büro", floorId: null }],
          }),
        entities: () =>
          json({ entities: [mood("office-abend", "Abend", "room-office")] }),
      },
    });
    expect(replies).toEqual([{ text: "Büro: Abend.", confirmation: true }]);
  });
});
