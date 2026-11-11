import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createAppContext,
  defineAction,
  defineApp,
  defineWidget,
  toStaticManifest,
  widgetContent,
  widgetContentProblems,
  type AppDefinition,
  type CoreCalls,
  type WidgetBlock,
  type WidgetContent,
} from "../src/index.js";

// Widgets: a card is a few blocks from a fixed list, with typed values the
// shell writes, which the core checks whenever the app shows one and
// defineApp() checks for a widget's preview.

const weather: WidgetContent = {
  blocks: [
    { kind: "headline", icon: "cloud-sun", value: { temperature: 8.2 } },
    {
      kind: "line",
      text: "Partly cloudy · H {high} L {low} · {rain} rain",
      values: {
        high: { temperature: 10 },
        low: { temperature: 6 },
        rain: { percent: 3 },
      },
    },
    {
      kind: "facts",
      items: [
        {
          icon: "sunrise",
          label: "Sunrise",
          value: { time: "2026-11-03T06:04:00Z" },
        },
        {
          icon: "sunset",
          label: "Sunset",
          value: { time: "2026-11-03T16:02:00.000Z" },
        },
      ],
    },
    {
      kind: "columns",
      items: [
        {
          label: { date: "2026-11-04" },
          icon: "cloud-rain",
          iconLabel: "Rain",
          value: { temperature: 9 },
          detail: { temperature: 4 },
        },
      ],
    },
  ],
};

const list: WidgetContent = {
  blocks: [
    { kind: "headline", value: "5 items" },
    {
      kind: "rows",
      items: [
        {
          text: "First item",
          detail: "Maya",
          value: { number: 2 },
          check: {
            checked: false,
            action: "example.tick",
            input: { item: "milk" },
          },
        },
      ],
    },
    { kind: "action", label: "Add item", page: "main" },
  ],
};

const blocks = (...each: unknown[]) => ({ blocks: each });
const fact = {
  icon: "sunrise",
  label: "Sunrise",
  value: { time: "2026-11-03T06:04:00Z" },
};
const column = {
  label: { date: "2026-11-04" },
  icon: "sun",
  iconLabel: "Clear",
  value: { temperature: 9 },
};

describe("a card", () => {
  it("is a few blocks with typed values", () => {
    expect(widgetContent.parse(weather)).toEqual(weather);
    expect(widgetContent.parse(list)).toEqual(list);
    expect(
      widgetContent.parse(
        blocks(
          { kind: "note", text: "No forecast yet." },
          {
            kind: "line",
            text: "{light} in the hall",
            values: { light: { number: 320, unit: "lux" } },
          },
          {
            kind: "line",
            text: "Back on {day}",
            values: { day: { date: "2026-11-04", as: "day" } },
          },
          {
            kind: "action",
            label: "Water now",
            action: "example.tick",
            input: {},
          },
        ),
      ).blocks,
    ).toHaveLength(4);
  });

  it.each<[string, unknown]>([
    ["no blocks", blocks()],
    [
      "more than eight blocks",
      blocks(
        ...Array.from({ length: 9 }, () => ({ kind: "note", text: "Hi" })),
      ),
    ],
    ["a block of an unknown kind", blocks({ kind: "chart", points: [] })],
    [
      "an icon outside the shell's list",
      blocks({ kind: "headline", icon: "rocket", value: "Go" }),
    ],
    [
      "a field a block does not have",
      blocks({ kind: "note", text: "Hi", colour: "red" }),
    ],
    [
      "a line that names a value it does not give",
      blocks({ kind: "line", text: "H {high}", values: {} }),
    ],
    [
      "a value no line names",
      blocks({
        kind: "line",
        text: "Clear",
        values: { high: { temperature: 9 } },
      }),
    ],
    ["two lines of text", blocks({ kind: "note", text: "First\nSecond" })],
    [
      "a text over 120 characters",
      blocks({ kind: "note", text: "x".repeat(121) }),
    ],
    ["an empty text", blocks({ kind: "note", text: "  " })],
    [
      "a time with no zone",
      blocks({
        kind: "facts",
        items: [{ ...fact, value: { time: "2026-11-03T06:04:00" } }],
      }),
    ],
    [
      "a date that is no day",
      blocks({
        kind: "columns",
        items: [{ ...column, label: { date: "Wednesday" } }],
      }),
    ],
    [
      "a number of an unknown unit",
      blocks({ kind: "headline", value: { number: 3, unit: "parsecs" } }),
    ],
    [
      "a temperature that is no number",
      blocks({ kind: "headline", value: { temperature: "8" } }),
    ],
    [
      "more than four facts",
      blocks({ kind: "facts", items: Array(5).fill(fact) }),
    ],
    [
      "more than seven columns",
      blocks({ kind: "columns", items: Array(8).fill(column) }),
    ],
    [
      "more than six rows",
      blocks({ kind: "rows", items: Array(7).fill({ text: "First item" }) }),
    ],
    [
      "two buttons",
      blocks(
        { kind: "action", label: "Add item", page: "main" },
        { kind: "action", label: "Clear", page: "main" },
      ),
    ],
    [
      "a button before the last block",
      blocks(
        { kind: "action", label: "Add item", page: "main" },
        { kind: "note", text: "Hi" },
      ),
    ],
    [
      "a button that does nothing",
      blocks({ kind: "action", label: "Add item" }),
    ],
    [
      "a button that both runs and opens",
      blocks({
        kind: "action",
        label: "Add item",
        action: "example.tick",
        page: "main",
      }),
    ],
    [
      "a button that opens a page with an input",
      blocks({ kind: "action", label: "Add item", page: "main", input: {} }),
    ],
  ])("refuses %s", (_case, card) => {
    expect(widgetContent.safeParse(card).success).toBe(false);
  });

  it("runs only the app's own read and write actions, and opens only its pages", () => {
    const tick = defineAction({
      id: "example.tick",
      title: "Tick",
      tier: "write",
      input: z.object({ item: z.string() }),
      output: z.object({}),
      run: async () => ({}),
    });
    const wipe = defineAction({
      ...tick,
      id: "example.wipe",
      tier: "destructive",
    });
    const app = { actions: [tick, wipe], pages: ["main"] };
    const row = (action: string): WidgetBlock => ({
      kind: "rows",
      items: [
        { text: "First item", check: { checked: true, action, input: {} } },
      ],
    });

    expect(widgetContentProblems(app, list)).toEqual([]);
    expect(
      widgetContentProblems(app, {
        blocks: [
          row("example.wipe"),
          row("example.unknown"),
          { kind: "action", label: "Open", page: "settings" },
        ],
      }),
    ).toEqual([
      "its check runs example.wipe, which is not one of its read or write actions",
      "its check runs example.unknown, which is not one of its read or write actions",
      "its button opens settings, which is not one of its pages",
    ]);
    expect(
      widgetContentProblems(app, {
        blocks: [{ kind: "action", label: "Wipe", action: "example.wipe" }],
      }),
    ).toEqual([
      "its button runs example.wipe, which is not one of its read or write actions",
    ]);
  });

  it("runs an action with an input it takes, no input being {}", () => {
    const tick = defineAction({
      id: "example.tick",
      title: "Tick",
      tier: "write",
      input: z.object({ item: z.string() }),
      output: z.object({}),
      run: async () => ({}),
    });
    const app = { actions: [tick], pages: [] };

    expect(
      widgetContentProblems(app, {
        blocks: [
          {
            kind: "rows",
            items: [
              {
                text: "First item",
                check: {
                  checked: false,
                  action: "example.tick",
                  input: { item: 3 },
                },
              },
            ],
          },
          { kind: "action", label: "Tick", action: "example.tick" },
        ],
      }),
    ).toEqual([
      "its check runs example.tick with an input it does not take",
      "its button runs example.tick with an input it does not take",
    ]);
  });
});

const card = defineWidget({
  id: "lamp.card",
  title: "Lamp",
  size: { columns: 4, rows: 2 },
  preview: {
    blocks: [
      { kind: "headline", value: { percent: 80 } },
      { kind: "line", text: "  Warm white  " },
    ],
  },
});

function lamp(changes: Partial<AppDefinition> = {}): AppDefinition {
  return {
    id: "sanctum.lamp",
    name: "Lamp",
    version: "0.1.0",
    core: "^1.0.0",
    permissions: [],
    actions: [],
    events: [],
    provides: { widgets: [card] },
    ...changes,
  };
}

describe("a widget", () => {
  it("is in the manifest with its size and its preview", () => {
    expect(toStaticManifest(defineApp(lamp())).provides.widgets).toEqual([
      {
        id: "lamp.card",
        title: "Lamp",
        size: { columns: 4, rows: 2 },
        // As checked, so its words are trimmed as their length was measured.
        preview: {
          blocks: [
            { kind: "headline", value: { percent: 80 } },
            { kind: "line", text: "Warm white" },
          ],
        },
      },
    ]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      "a size other than four cells wide",
      { size: { columns: 2, rows: 2 } },
      "four cells wide",
    ],
    [
      "more than eight rows",
      { size: { columns: 4, rows: 9 } },
      "four cells wide",
    ],
    ["no preview", { preview: undefined }, "previews a card"],
    [
      "a preview that is no card",
      { preview: blocks({ kind: "chart" }) },
      "previews a card",
    ],
    [
      "a preview that opens a page the app does not have",
      { preview: blocks({ kind: "action", label: "Open", page: "main" }) },
      "its button opens main, which is not one of its pages",
    ],
    ["an empty title", { title: " " }, "needs a namespaced id"],
  ])("refuses %s", (_case, changes, message) => {
    expect(() =>
      defineApp(
        lamp({
          provides: { widgets: [{ ...card, ...changes } as typeof card] },
        }),
      ),
    ).toThrow(message);
  });

  it("shows a card as an entity of its own type, named for it, and hides it", async () => {
    const publish = vi.fn(async () => {});
    const unpublish = vi.fn(async () => {});
    const ctx = createAppContext({
      appId: "sanctum.lamp",
      actor: { kind: "app", id: "sanctum.lamp" },
      core: { publish, unpublish } as unknown as CoreCalls,
    });

    await ctx.widgets.show(card, "desk", card.preview);
    await ctx.widgets.hide("desk");

    expect(publish).toHaveBeenCalledWith({
      type: "lamp.card",
      key: "desk",
      name: "Lamp",
      state: card.preview,
    });
    expect(unpublish).toHaveBeenCalledWith("desk");
  });
});
