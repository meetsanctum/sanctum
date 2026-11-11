import {
  defineAction,
  defineApp,
  defineWidget,
  type AppDefinition,
  type AppInfo,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { claimed, get, post, testCore } from "./support.js";

// Widgets: an app shows its widgets' cards as entities of each widget's type,
// which the core checks against the card's shape, and against what the app may
// run and open, and keeps for the shell to draw.

const board = defineWidget({
  id: "example.board",
  title: "Board",
  size: { columns: 4, rows: 4 },
  preview: { blocks: [{ kind: "headline", value: "5 items" }] },
});

// Shows whatever card a test asks, as the app.
const show = defineAction({
  id: "example.show",
  title: "Show",
  tier: "write",
  input: z.object({ key: z.string(), card: z.unknown() }),
  output: z.object({}),
  async run(ctx, input) {
    await ctx.widgets.show(board, input.key, input.card as never);
    return {};
  },
});
const hide = defineAction({
  id: "example.hide",
  title: "Hide",
  tier: "write",
  input: z.object({ key: z.string() }),
  output: z.object({}),
  async run(ctx, input) {
    await ctx.widgets.hide(input.key);
    return {};
  },
});
const tick = defineAction({
  id: "example.tick",
  title: "Tick",
  tier: "write",
  input: z.object({ item: z.string() }),
  output: z.object({}),
  run: async () => ({}),
});
const wipe = defineAction({ ...tick, id: "example.wipe", tier: "destructive" });

const example = defineApp({
  id: "test.example",
  name: "Example",
  version: "0.1.0",
  core: "^1.0.0",
  icon: { glyph: "list-checks", color: "leaf" },
  pages: ["main"],
  permissions: [],
  actions: [show, hide, tick, wipe],
  events: [],
  provides: { widgets: [board] },
});

const milk = {
  blocks: [
    { kind: "headline", value: "1 item" },
    {
      kind: "rows",
      items: [
        {
          text: "First item",
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

async function home() {
  const core = await testCore({ apps: [{ app: example, origin: "official" }] });
  const maya = await claimed(core);
  const call = (id: string, input: object) =>
    post(core, `/api/apps/test.example/actions/${id}`, input, maya);
  return { core, maya, call };
}

describe("a widget", () => {
  it("is listed with its size, for clients to place", async () => {
    const { core, maya } = await home();
    const apps = (await get(core, "/api/apps", maya)).json<AppInfo[]>();

    expect(
      apps.find((app) => app.id === "test.example")?.provides.widgets,
    ).toEqual([
      {
        id: "example.board",
        title: "Board",
        size: { columns: 4, rows: 4 },
      },
    ]);
  });

  it("has its cards kept as entities of its type, named for it", async () => {
    const { core, maya, call } = await home();

    expect(
      (await call("example.show", { key: "weekly", card: milk })).statusCode,
    ).toBe(200);

    expect(
      (
        await get(
          core,
          "/api/entities?app=test.example&type=example.board",
          maya,
        )
      ).json(),
    ).toMatchObject([
      {
        app: "test.example",
        key: "weekly",
        type: "example.board",
        name: "Board",
        state: milk,
      },
    ]);

    await call("example.hide", { key: "weekly" });
    expect(core.entities.list()).toEqual([]);
  });

  it.each<[string, unknown, string]>([
    [
      "is no card",
      { blocks: [{ kind: "chart" }] },
      "does not fit example.board",
    ],
    [
      "runs an action that is not one of the app's",
      {
        blocks: [
          { kind: "action", label: "Order", action: "shop.order", input: {} },
        ],
      },
      "its button runs shop.order, which is not one of its read or write actions",
    ],
    [
      "has a check run a destructive action",
      {
        blocks: [
          {
            kind: "rows",
            items: [
              {
                text: "First item",
                check: { checked: true, action: "example.wipe", input: {} },
              },
            ],
          },
        ],
      },
      "its check runs example.wipe",
    ],
    [
      "opens a page the app does not have",
      { blocks: [{ kind: "action", label: "Open", page: "settings" }] },
      "its button opens settings, which is not one of its pages",
    ],
    [
      "runs its action with an input it does not take",
      { blocks: [{ kind: "action", label: "Tick", action: "example.tick" }] },
      "its button runs example.tick with an input it does not take",
    ],
  ])("fails the app when its card %s", async (_case, card, message) => {
    const { core, call } = await home();

    expect(
      (await call("example.show", { key: "weekly", card })).statusCode,
    ).toBe(500);

    expect(core.entities.list()).toEqual([]);
    expect(core.logs.join("\n")).toContain(message);
  });

  it("keeps its cards across a restart, and they go with a version that drops it", async () => {
    const { core, call } = await home();
    await call("example.show", { key: "weekly", card: milk });

    const next = await testCore({
      dataDir: core.dataDir,
      apps: [{ app: example, origin: "official" }],
    });
    expect(next.entities.list().map((each) => each.key)).toEqual(["weekly"]);

    const without = await testCore({
      dataDir: core.dataDir,
      apps: [
        {
          app: defineApp({ ...example, version: "0.2.0", provides: {} }),
          origin: "official",
        },
      ],
    });
    expect(without.entities.list()).toEqual([]);
  });

  it.each<[string, Partial<AppDefinition>]>([
    ["removes its action", { actions: [show, hide, wipe] }],
    [
      "makes its action destructive",
      { actions: [show, hide, { ...tick, tier: "destructive" }, wipe] },
    ],
    ["removes its page", { pages: [] }],
  ])("removes saved cards when an update %s", async (_case, changes) => {
    const { core, call } = await home();
    const note = { blocks: [{ kind: "note", text: "Nothing to buy." }] };
    await call("example.show", { key: "weekly", card: milk });
    await call("example.show", { key: "empty", card: note });
    await call("example.show", {
      key: "button",
      card: {
        blocks: [
          {
            kind: "action",
            label: "Tick",
            action: "example.tick",
            input: { item: "milk" },
          },
        ],
      },
    });

    const next = await testCore({
      dataDir: core.dataDir,
      apps: [
        {
          app: defineApp({ ...example, ...changes, version: "0.2.0" }),
          origin: "official",
        },
      ],
    });

    expect(next.entities.get(example.id, "weekly")).toBeNull();
    expect(next.entities.get(example.id, "empty")?.state).toEqual(note);
    expect(next.entities.get(example.id, "button") !== null).toBe(
      changes.actions === undefined,
    );
  });
});
