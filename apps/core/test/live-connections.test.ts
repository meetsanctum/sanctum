import { describe, expect, it } from "vitest";

import type { Principal } from "../src/auth/clients.js";
import {
  lampsCore,
  openLive,
  personWithClient,
  radio,
  settled,
} from "./devices-support.js";
import {
  claimed,
  post,
  setLogin,
  sharedClient,
  testCore,
  type TestCore,
} from "./support.js";

// Who hears the core's live updates: a connection hears them as what it
// authenticated as for as long as it is open, and closes as its person is
// removed or its client revoked. Sending an update asks People nothing.

// A connection of a principal's that stays in the test's hands: what it was
// sent, and whether the core closed it. Unlike a socket, it could still be
// sent to once closed, so it shows the core has let go of it.
function listen(core: TestCore, principal: Principal) {
  const heard: { type: string; [field: string]: unknown }[] = [];
  const state = { heard, closed: false };
  core.auth.connections.add(principal, {
    close() {
      state.closed = true;
    },
    send(message) {
      heard.push(JSON.parse(String(message)));
    },
  });
  return state;
}

const listenAs = (core: TestCore, token: string) =>
  listen(core, core.auth.clients.authenticate(token)!);

async function household() {
  const core = await testCore();
  const maya = await claimed(core);
  const ben = personWithClient(core);
  // Something every client hears of.
  let rooms = 0;
  const change = async () => {
    const added = await post(
      core,
      "/api/places/rooms/add",
      { name: `Room ${++rooms}` },
      maya,
    );
    expect(added.statusCode).toBe(200);
  };
  const places = (connection: { heard: { type: string }[] }) =>
    connection.heard.filter((message) => message.type === "places").length;
  return { core, maya, ben, change, places };
}

describe("a live connection", () => {
  it("closes as its person is removed, whoever removes them, and hears nothing after", async () => {
    const { core, maya, ben, change, places } = await household();
    const theirs = await openLive(core, ben.token);
    const kept = listenAs(core, ben.token);
    const mine = listenAs(core, maya.token);
    await change();
    expect(places(kept)).toBe(1);

    // Not through People's route.
    core.people.remove(ben.person.id);

    expect(kept.closed).toBe(true);
    expect((await theirs.closed).code).toBe(4401);
    await change();
    expect(places(kept)).toBe(1);
    expect(places(mine)).toBe(2);
    expect(mine.closed).toBe(false);
  });

  it("closes as its client is revoked, and hears nothing after", async () => {
    const { core, maya, ben, change, places } = await household();
    const theirs = await openLive(core, ben.token);
    const kept = listenAs(core, ben.token);
    const mine = listenAs(core, maya.token);

    const revoked = await post(
      core,
      "/api/auth/clients/revoke",
      { id: ben.client.id },
      maya,
    );

    expect(revoked.statusCode).toBe(204);
    expect(kept.closed).toBe(true);
    expect((await theirs.closed).code).toBe(4401);
    await change();
    expect(places(kept)).toBe(0);
    expect(places(mine)).toBe(1);
  });

  it("stays open and hearing when the removal is refused", async () => {
    const { core, maya, ben, change, places } = await household();
    const mine = await openLive(core, maya.token);
    const kept = listenAs(core, maya.token);

    // Maya is the only one who can sign in.
    const refused = await post(
      core,
      "/api/people/remove",
      { id: maya.person.id },
      { token: ben.token },
    );

    expect(refused.json()).toEqual({ error: "last_login" });
    await settled();
    expect(kept.closed).toBe(false);
    expect(mine.socket.readyState).toBe(mine.socket.OPEN);
    await change();
    expect(places(kept)).toBe(1);
    mine.socket.terminate();
  });

  it("stays open and hearing when the transaction around the removal is undone", async () => {
    const { core, ben, change, places } = await household();
    const theirs = await openLive(core, ben.token);
    const kept = listenAs(core, ben.token);

    expect(() =>
      core.db.transaction(() => {
        core.people.remove(ben.person.id);
        throw new Error("undone");
      }),
    ).toThrow("undone");

    await settled();
    expect(core.people.get(ben.person.id)).toBeDefined();
    expect(kept.closed).toBe(false);
    expect(theirs.socket.readyState).toBe(theirs.socket.OPEN);
    await change();
    expect(places(kept)).toBe(1);
    theirs.socket.terminate();
  });

  it("closes once the transaction around the removal has committed, not before", async () => {
    const { core, maya, ben, change, places } = await household();
    await setLogin(core, maya.token, {
      personId: ben.person.id,
      username: "ben",
      password: "another long password",
    });
    const kept = listenAs(core, ben.token);

    core.db.transaction(() => {
      core.people.remove(ben.person.id);
      expect(kept.closed).toBe(false);
    });

    await settled();
    expect(kept.closed).toBe(true);
    await change();
    expect(places(kept)).toBe(0);
  });
});

describe("a widget token's connection", () => {
  it("hears nothing", async () => {
    const { core, maya } = await lampsCore();
    const widgets = listen(core, {
      client: { id: "kitchen", kind: "shared", name: "Kitchen tablet" },
      scope: "widgets",
    });
    const shared = listenAs(core, sharedClient(core).token);

    await radio.press("lamp-1", { on: true });
    for (const [url, body] of [
      ["/api/places/rooms/add", { name: "Office" }],
      ["/api/dashboards/add", { name: "Den" }],
      ["/api/pins/update", { apps: ["sanctum.settings"] }],
      ["/api/devices/pairing/open", {}],
    ] as const) {
      expect((await post(core, url, body, maya)).statusCode).toBeLessThan(300);
    }
    await settled();

    expect(new Set(shared.heard.map((message) => message.type))).toEqual(
      new Set([
        "device",
        "places",
        "dashboards",
        "pins",
        "pairing",
        "activity",
      ]),
    );
    expect(widgets.heard).toEqual([]);
  });
});

// Every statement the core has SQLite compile from here on, by its text.
function compiled(core: TestCore) {
  const sqlite = core.db.$client;
  const prepare = sqlite.prepare.bind(sqlite);
  const texts: string[] = [];
  sqlite.prepare = ((text: string) => {
    texts.push(text);
    return prepare(text);
  }) as typeof sqlite.prepare;
  return texts;
}

describe("a device's change", () => {
  it("reaches a person's own client without a statement that reads People", async () => {
    const { core, maya, lamp } = await lampsCore();
    const ben = personWithClient(core);
    const live = [
      await openLive(core, maya.token),
      await openLive(core, ben.token),
    ];
    const texts = compiled(core);

    // Its wall switch, so no request passes the gate.
    await radio.press("lamp-1", { on: true });
    await settled();

    for (const { messages, socket } of live) {
      expect(messages).toContainEqual(
        expect.objectContaining({ type: "device", id: lamp }),
      );
      socket.terminate();
    }
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.filter((text) => /\bfrom "people"/.test(text))).toEqual([]);
  });
});
