import {
  defineAction,
  defineApp,
  defineEntityType,
  registerPermission,
  toStaticManifest,
  type AiCanUse,
  type Actor,
  type StaticManifest,
} from "@meetsanctum/app-sdk";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { createAgentsCanUse, type AppOffers } from "../src/agents/can-use.js";
import { agentItems } from "../src/agents/schema.js";
import { createCoreCalls } from "../src/app-host/calls.js";
import { contractOf } from "../src/app-host/contract.js";
import { lampsCore, personWithClient, radio } from "./devices-support.js";
import type { AppPackage } from "./runner-apps.js";
import { claimed, get, post, testCore, type TestCore } from "./support.js";

// What AI agents can use: one list for every AI agent, which the household
// decides on Settings and each app's page. Apps offer actions and entity
// types, the core's areas are permissions, and an AI agent's call holds to
// the list all the way through.

const seen: { people?: number }[] = [];

const tidy = defineAction({
  id: "example.tidy",
  title: "Tidy up",
  tier: "write",
  input: z.object({}),
  output: z.object({ people: z.number() }),
  assistant: {
    starts: "on",
    description: "Tidy the home, for everyone in it.",
    needs: ["people.read"],
  },
  async run(ctx) {
    const people = await ctx.people.list();
    seen.push({ people: people.length });
    return { people: people.length };
  },
});

const peek = defineAction({
  id: "example.peek",
  title: "Peek",
  tier: "read",
  input: z.object({}),
  output: z.object({}),
  assistant: { starts: "off", description: "Look at nothing much." },
  run: async () => ({}),
});

// Offered with no needs of its own, so only the core's check of what it
// reads stands between an AI agent and the household's names.
const count = defineAction({
  id: "example.count",
  title: "Count everyone",
  tier: "read",
  input: z.object({}),
  output: z.object({ people: z.number() }),
  assistant: { starts: "on", description: "Count the people at home." },
  async run(ctx) {
    return { people: (await ctx.people.list()).length };
  },
});

const reset = defineAction({
  id: "example.reset",
  title: "Reset",
  tier: "write",
  input: z.object({}),
  output: z.object({}),
  run: async () => ({}),
});

const longEntityId = `example.${"extended".repeat(16)}`;

const examplePackage: AppPackage = {
  app: defineApp({
    id: "sanctum.example",
    name: "Example",
    version: "0.1.0",
    core: "^2.0.0",
    permissions: [{ id: "people.read", reason: "For the test.", needed: true }],
    actions: [tidy, peek, count, reset],
    events: [],
    provides: {
      entities: [
        defineEntityType({
          id: reset.id,
          title: "Example state",
          state: z.object({}),
          assistant: { starts: "on", description: "See the example state." },
        }),
        defineEntityType({
          id: longEntityId,
          title: "Detailed state",
          state: z.object({}),
          assistant: { starts: "on", description: "See the detailed state." },
        }),
      ],
    },
  }),
  origin: "official",
};

async function household() {
  const core = await testCore({ apps: [examplePackage] });
  const maya = await claimed(core);
  const agent = core.auth.clients.createAgent({
    name: "Codex on the office Mac",
    platform: "macos",
    addedBy: { kind: "person", id: maya.person.id },
  });
  const principal = () => core.auth.clients.authenticate(agent.token)!;
  return { core, maya, agent, principal };
}

const canUse = async (core: TestCore, token: string) =>
  (await get(core, "/api/agents/can-use", { token })).json<AiCanUse>();

type Principal = NonNullable<
  ReturnType<TestCore["auth"]["clients"]["authenticate"]>
>;

function run(core: TestCore, principal: Principal, actionId: string) {
  return core.apps.call({
    principal,
    appId: "sanctum.example",
    actionId,
    input: {},
  });
}

describe("what AI agents can use", () => {
  it("starts with the lights and switches to see, and each app's defaults", async () => {
    const { core, maya } = await household();

    const list = await canUse(core, maya.token);

    expect(list.areas.filter((area) => area.on)).toEqual([
      { id: "places.read", on: true, always: true },
      { id: "devices.control:light", on: true, always: false },
      { id: "devices.read:switch", on: true, always: false },
    ]);
    expect(list.areas.map((area) => area.id)).toEqual(
      expect.arrayContaining([
        "devices.control:switch",
        "devices.read:motion",
        "activity.read",
        "history.read",
        "people.read",
      ]),
    );
    // Lights are seen by controlling them, and a sensor's own settings are
    // never on the list.
    expect(list.areas.map((area) => area.id)).not.toContain(
      "devices.read:light",
    );
    expect(list.areas.map((area) => area.id)).not.toContain(
      "devices.control:motion",
    );
    expect(
      list.offers.filter((offer) => offer.app === "sanctum.example"),
    ).toEqual([
      {
        app: "sanctum.example",
        id: "example.tidy",
        kind: "action",
        tier: "write",
        title: "Tidy up",
        description: "Tidy the home, for everyone in it.",
        on: true,
        needs: ["people.read"],
        missing: ["people.read"],
      },
      {
        app: "sanctum.example",
        id: "example.peek",
        kind: "action",
        tier: "read",
        title: "Peek",
        description: "Look at nothing much.",
        on: false,
        needs: [],
        missing: [],
      },
      {
        app: "sanctum.example",
        id: "example.count",
        kind: "action",
        tier: "read",
        title: "Count everyone",
        description: "Count the people at home.",
        on: true,
        needs: [],
        missing: [],
      },
      {
        app: "sanctum.example",
        id: reset.id,
        kind: "entity",
        tier: "read",
        title: "Example state",
        description: "See the example state.",
        on: true,
        needs: [],
        missing: [],
      },
      {
        app: "sanctum.example",
        id: longEntityId,
        kind: "entity",
        tier: "read",
        title: "Detailed state",
        description: "See the detailed state.",
        on: true,
        needs: [],
        missing: [],
      },
    ]);
  });

  it("is the household's to change, never an AI agent's", async () => {
    const { core, maya, agent } = await household();

    for (const [method, url] of [
      ["get", "/api/agents/can-use"],
      ["post", "/api/agents/can-use/area"],
      ["post", "/api/agents/can-use/offer"],
    ] as const) {
      const response =
        method === "get"
          ? await get(core, url, { token: agent.token })
          : await post(
              core,
              url,
              { id: "people.read", on: true },
              { token: agent.token },
            );
      expect(response.statusCode, url).toBe(403);
    }

    const switched = await post(
      core,
      "/api/agents/can-use/area",
      { id: "people.read", on: true },
      maya,
    );
    expect(switched.statusCode).toBe(200);
    expect(
      switched.json<AiCanUse>().areas.find((area) => area.id === "people.read")
        ?.on,
    ).toBe(true);
    const entry = core.activity
      .recent()
      .find((each) => each.action === "agents.can-use");
    expect(entry).toMatchObject({
      source: "agents",
      outcome: "ok",
      subjectId: "people.read",
      personId: maya.person.id,
      detail: { item: "people.read", on: true },
    });
  });

  it("keeps the home overview on and refuses what isn't on the list", async () => {
    const { core, maya } = await household();

    for (const body of [
      { id: "places.read", on: false },
      { id: "devices.control:motion", on: true },
      { id: "workflows.manage", on: true },
    ]) {
      const response = await post(core, "/api/agents/can-use/area", body, maya);
      expect(response.statusCode, body.id).toBe(400);
    }
    const unknown = await post(
      core,
      "/api/agents/can-use/offer",
      { app: "sanctum.example", id: "example.unknown", on: true },
      maya,
    );
    expect(unknown.statusCode).toBe(404);
  });

  it("runs an app's action only while it and what it needs are on", async () => {
    const { core, maya, principal } = await household();
    seen.length = 0;

    await expect(run(core, principal(), "example.tidy")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(
      core.activity.recent().find((each) => each.action === "example.tidy"),
    ).toMatchObject({ outcome: "refused", reason: "forbidden" });

    await post(
      core,
      "/api/agents/can-use/area",
      { id: "people.read", on: true },
      maya,
    );
    expect(await run(core, principal(), "example.tidy")).toEqual({
      people: 1,
    });

    await post(
      core,
      "/api/agents/can-use/offer",
      { app: "sanctum.example", id: "example.tidy", on: false },
      maya,
    );
    await expect(run(core, principal(), "example.tidy")).rejects.toMatchObject({
      code: "forbidden",
    });
    // An entity's switch does not apply to an action with the same id.
    await expect(run(core, principal(), "example.reset")).rejects.toMatchObject(
      { code: "forbidden" },
    );
    await expect(run(core, principal(), "example.peek")).rejects.toMatchObject({
      code: "forbidden",
    });
    await post(
      core,
      "/api/agents/can-use/offer",
      { app: "sanctum.example", id: "example.peek", on: true },
      maya,
    );
    expect(await run(core, principal(), "example.peek")).toEqual({});
    expect(seen).toEqual([{ people: 1 }]);
  });

  it("holds what an allowed action reads to the list", async () => {
    const { core, maya, principal } = await household();
    personWithClient(core);

    await expect(run(core, principal(), "example.count")).rejects.toMatchObject(
      { code: "forbidden" },
    );

    await post(
      core,
      "/api/agents/can-use/area",
      { id: "people.read", on: true },
      maya,
    );
    expect(await run(core, principal(), "example.count")).toEqual({
      people: 2,
    });
  });

  it("can switch an offer with a long manifest id off", async () => {
    const { core, maya } = await household();
    const response = await post(
      core,
      "/api/agents/can-use/offer",
      { app: "sanctum.example", id: longEntityId, on: false },
      maya,
    );
    expect(response.statusCode).toBe(200);
    expect(
      response.json<AiCanUse>().offers.find(({ id }) => id === longEntityId)
        ?.on,
    ).toBe(false);
  });

  it("leaves a person's own calls alone", async () => {
    const { core, maya } = await household();

    const response = await post(
      core,
      "/api/apps/sanctum.example/actions/example.reset",
      {},
      maya,
    );

    expect(response.statusCode).toBe(200);
  });
});

describe("an AI agent's device command", () => {
  it("goes through for the lights and waits for switches to be switched on", async () => {
    const { core, maya, lamp, plug } = await lampsCore();
    const agent = core.auth.clients.createAgent({
      name: "Codex on the office Mac",
      platform: "macos",
      addedBy: { kind: "person", id: maya.person.id },
    });
    const actor: Actor = core.gate.admit(
      core.auth.clients.authenticate(agent.token)!,
      { tier: "write" },
    );
    const command = (device: string, capability: string) =>
      core.devices.command(
        actor,
        { device, capability, command: { on: true } },
        {},
        null,
      );

    await expect(command(lamp, "light")).resolves.toMatchObject({
      kind: "light",
    });
    await expect(command(plug, "power")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(
      core.activity
        .recent()
        .find(
          (each) => each.action === "device.command" && each.subjectId === plug,
        ),
    ).toMatchObject({ outcome: "refused", reason: "forbidden" });

    core.agentsCanUse.setArea("devices.control:switch", true, {
      clientId: maya.client.id,
    });
    await expect(command(plug, "power")).resolves.toMatchObject({
      kind: "switch",
    });
    expect(radio.received.length).toBeGreaterThanOrEqual(2);
  });

  it("does not resend after the household switches off control", async () => {
    const { core, maya, lamp } = await lampsCore({ confirmMs: 250 });
    radio.confirms = false;
    const agent = core.auth.clients.createAgent({
      name: "Office agent",
      platform: "macos",
      addedBy: { kind: "person", id: maya.person.id },
    });

    await core.devices.commandFor(
      core.auth.clients.authenticate(agent.token)!,
      {
        device: lamp,
        capability: "light",
        command: { on: true },
      },
    );
    core.agentsCanUse.setArea("devices.control:light", false, {
      clientId: maya.client.id,
    });

    const entry = () =>
      core.activity.recent().find((each) => each.action === "device.command");
    await expect
      .poll(entry)
      .toMatchObject({ outcome: "failed", reason: "forbidden" });
    expect(radio.received).toHaveLength(1);
    expect(entry()?.detail?.resent).toBeUndefined();
  });
});

describe("answers kept for an app's offers", () => {
  const offers = (tier: "read" | "write") =>
    contractOf(
      // The manifest as the core reads it from a package.
      JSON.parse(
        JSON.stringify(
          toStaticManifest(
            defineApp({
              id: "sanctum.example",
              name: "Example",
              version: "0.1.0",
              core: "^2.0.0",
              permissions: [],
              actions: [
                defineAction({
                  id: "example.look",
                  title: "Look",
                  tier,
                  input: z.object({}),
                  output: z.object({}),
                  assistant: { starts: "on", description: "Look around." },
                  run: async () => ({}),
                }),
              ],
              events: [],
            }),
          ),
        ),
      ) as StaticManifest,
    ).offers;

  async function store() {
    const core = await testCore();
    let apps: AppOffers[] = [];
    const store = createAgentsCanUse(core.db, {
      record: core.activity.for("agents"),
      apps: () => apps,
    });
    const install = (offered: AppOffers["offers"], asUpdate: boolean) => {
      apps = [{ app: "sanctum.example", offers: offered }];
      store.adopt(apps[0]!, { asUpdate });
    };
    const isOn = () =>
      store.canUse("sanctum.example", "example.look", "action");
    return { db: core.db, store, install, isOn };
  }

  it("allows offers that share a prerequisite and denies cycles", async () => {
    const { store: canUse, install, isOn } = await store();
    const look = offers("read").get("example.look")!;
    const entries = [
      { ...look, needs: ["example.left", "example.right"] },
      { ...look, id: "example.left", needs: ["example.shared"] },
      { ...look, id: "example.right", needs: ["example.shared"] },
      { ...look, id: "example.shared" },
      { ...look, id: "example.first", needs: ["example.second"] },
      { ...look, id: "example.second", needs: ["example.first"] },
    ];
    install(new Map(entries.map((offer) => [offer.id, offer])), false);

    expect(isOn()).toBe(true);
    expect(canUse.canUse("sanctum.example", "example.first", "action")).toBe(
      false,
    );
    expect(
      canUse.list().offers.find(({ id }) => id === look.id)?.missing,
    ).toEqual([]);
    expect(
      canUse.list().offers.find(({ id }) => id === "example.first")?.missing,
    ).toEqual(["example.second"]);
  });

  it("takes the app's default when the home adds it", async () => {
    const { install, isOn } = await store();
    install(offers("read"), false);
    expect(isOn()).toBe(true);
  });

  it("starts what a new version newly offers off", async () => {
    const { install, isOn } = await store();
    install(new Map(), false);
    install(offers("read"), true);
    expect(isOn()).toBe(false);
  });

  it("keeps separate answers for an action and an entity with the same id", async () => {
    const { store: canUse, install, isOn } = await store();
    const action = offers("read").get("example.look")!;
    install(offers("read"), false);
    expect(isOn()).toBe(true);

    install(new Map([[action.id, { ...action, kind: "entity" }]]), true);
    expect(canUse.canUse("sanctum.example", action.id, "entity")).toBe(false);
    expect(isOn()).toBe(false);

    install(offers("read"), true);
    expect(isOn()).toBe(true);
  });

  it("leaves an offer off when an earlier answer has no kind", async () => {
    const { db, install, isOn } = await store();
    db.insert(agentItems)
      .values({
        appId: "sanctum.example",
        itemId: "example.look",
        on: false,
        tier: "read",
        updatedAt: new Date(),
      })
      .run();

    install(offers("read"), false);
    expect(isOn()).toBe(false);
  });

  it("keeps an answer through an update, and switches one whose tier rose off", async () => {
    const { install, isOn } = await store();
    install(offers("read"), false);
    install(offers("read"), true);
    expect(isOn()).toBe(true);
    install(offers("write"), true);
    expect(isOn()).toBe(false);
  });
});

describe("an app's calls on an AI agent's behalf", () => {
  async function agentCalls({ asDriver = false } = {}) {
    const { core, maya, lamp, plug } = await lampsCore();
    const agent = core.auth.clients.createAgent({
      name: "Codex on the office Mac",
      platform: "macos",
      addedBy: { kind: "person", id: maya.person.id },
    });
    const calls = createCoreCalls({
      appId: asDriver ? core.devices.get(lamp)!.driver : "sanctum.example",
      actor: {
        kind: "assistant-run",
        id: agent.client.id,
        onBehalfOf: maya.person.id,
      },
      permissions: () =>
        asDriver
          ? [registerPermission]
          : [
              "devices.control:light",
              "devices.control:switch",
              "devices.read:button",
            ],
      permissionsRevision: () => 0,
      query: async () => ({}),
      ended: () => false,
      services: new Map(),
      people: core.people,
      places: core.places,
      devices: core.devices,
      presses: core.presses,
      firmware: core.firmware,
      problems: { report() {} },
      found: { report() {} },
      emit() {},
      entities: core.entities,
      agents: core.agentsCanUse,
      entityType: () => undefined,
      isTileType: () => false,
      settings: () => ({}),
      net: async () => {
        throw new Error("No internet here");
      },
      watch: () => ({ signal: new AbortController().signal, done() {} }),
      pairing: () => core.pairing,
      secrets: { get: () => null, put() {}, remove() {} },
      jobs: {
        schedule: () => {
          throw new Error("Not on an AI agent's behalf");
        },
        cancel() {},
        list: () => [],
      },
      log() {},
    });
    return { core, maya, lamp, plug, calls };
  }

  it("sees the devices both the app and AI agents may see", async () => {
    const { core, maya, lamp, plug, calls } = await agentCalls();

    expect((await calls.devices()).map((device) => device.id).sort()).toEqual(
      [lamp, plug].sort(),
    );
    core.agentsCanUse.setArea("devices.read:switch", false, {
      clientId: maya.client.id,
    });
    expect((await calls.devices()).map((device) => device.id)).toEqual([lamp]);
    await expect(calls.device(plug)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("leaves nothing behind that outlives the call", async () => {
    const { calls } = await agentCalls();

    await expect(
      calls.scheduleJob({
        key: "later",
        action: "example.tidy",
        input: {},
        when: { at: "2026-11-22T08:00:00.000Z" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a driver sees the allowed kinds of its own devices", async () => {
    const { core, maya, lamp, plug, calls } = await agentCalls({
      asDriver: true,
    });
    expect((await calls.devices()).map((device) => device.id).sort()).toEqual(
      [lamp, plug].sort(),
    );

    core.agentsCanUse.setArea("devices.read:switch", false, {
      clientId: maya.client.id,
    });
    expect((await calls.devices()).map((device) => device.id)).toEqual([lamp]);
  });
});
