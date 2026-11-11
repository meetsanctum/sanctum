import { describe, expect, it } from "vitest";

import { openLive, personWithClient } from "./devices-support.js";
import {
  claimed,
  get,
  post,
  setLogin,
  sharedClient,
  testCore,
  type TestCore,
} from "./support.js";

// People's routes: every client lists the household and adds, changes and
// removes people, shared ones too, and a claimed host keeps someone who can
// sign in.

const jonas = { name: "Jonas", colour: "#B9DEFC" };

async function household() {
  const core = await testCore();
  const maya = await claimed(core);
  return { core, maya };
}

function entries(core: TestCore) {
  return core.activity.recent().filter((entry) => entry.source === "people");
}

describe("people's routes", () => {
  it("let someone add, change and remove someone", async () => {
    const { core, maya } = await household();

    const added = await post(core, "/api/people/add", jonas, maya);
    const { id } = added.json();
    const changed = await post(
      core,
      "/api/people/update",
      { id, avatar: "fox" },
      maya,
    );
    const listed = await get(core, "/api/people", maya);
    const removed = await post(core, "/api/people/remove", { id }, maya);

    expect(added.json()).toEqual({
      id: expect.any(String),
      name: "Jonas",
      avatar: null,
      colour: "#b9defc",
    });
    expect(changed.json()).toMatchObject({ name: "Jonas", avatar: "fox" });
    expect(
      listed.json().map((person: { name: string }) => person.name),
    ).toEqual(["Maya", "Jonas"]);
    expect(removed.statusCode).toBe(204);
    expect(core.people.get(id)).toBeUndefined();
    expect(
      entries(core)
        .map((entry) => entry.action)
        .sort(),
    ).toEqual(["person.add", "person.remove", "person.update"]);
    expect(entries(core)[0]).toMatchObject({
      personId: maya.person.id,
      clientId: maya.client.id,
      subjectId: id,
    });
  });

  it("list the household for anyone signed in, shared clients too", async () => {
    const { core } = await household();
    const kitchen = sharedClient(core);

    const listed = await get(core, "/api/people", { token: kitchen.token });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([expect.objectContaining({ name: "Maya" })]);
  });

  it("let every client change the household, shared ones too", async () => {
    const { core } = await household();
    const ben = personWithClient(core);
    const kitchen = sharedClient(core);

    const byBen = await post(core, "/api/people/add", jonas, {
      token: ben.token,
    });
    const byShared = await post(
      core,
      "/api/people/add",
      { ...jonas, name: "Ida" },
      { token: kitchen.token },
    );
    const renamed = await post(
      core,
      "/api/people/update",
      { id: ben.person.id, name: "Benjamin" },
      { token: kitchen.token },
    );

    expect(byBen.statusCode).toBe(200);
    expect(byShared.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "Benjamin" });
    expect(core.people.list()).toHaveLength(4);
    // A shared client changes them as the household: no person.
    expect(
      entries(core).filter((entry) => entry.clientId === kitchen.id),
    ).toEqual([
      expect.objectContaining({ action: "person.update", personId: null }),
      expect.objectContaining({ action: "person.add", personId: null }),
    ]);
  });

  it("keep someone who can sign in", async () => {
    const { core, maya } = await household();
    // Someone without a login does not count.
    const ben = personWithClient(core);

    const removed = await post(
      core,
      "/api/people/remove",
      { id: maya.person.id },
      { token: ben.token },
    );

    expect(removed.statusCode).toBe(409);
    expect(removed.json()).toEqual({ error: "last_login" });
    expect(core.people.get(maya.person.id)).toBeDefined();

    // Once Ben can sign in, Maya may go.
    await setLogin(core, maya.token, {
      personId: ben.person.id,
      username: "ben",
      password: "another long password",
    });
    const gone = await post(
      core,
      "/api/people/remove",
      { id: maya.person.id },
      { token: ben.token },
    );
    expect(gone.statusCode).toBe(204);
  });

  it("refuse what does not exist and what is malformed", async () => {
    const { core, maya } = await household();

    for (const [url, body, status] of [
      ["/api/people/update", { id: "nobody", name: "Kim" }, 404],
      ["/api/people/remove", { id: "nobody" }, 404],
      ["/api/people/add", { ...jonas, colour: "blue" }, 400],
      ["/api/people/update", { name: "Kim" }, 400],
    ] as const) {
      expect((await post(core, url, body, maya)).statusCode).toBe(status);
    }
  });

  it("close the live connections of someone removed, at once", async () => {
    const { core, maya } = await household();
    const ben = personWithClient(core);
    const theirs = await openLive(core, ben.token);
    const mine = await openLive(core, maya.token);

    await post(core, "/api/people/remove", { id: ben.person.id }, maya);

    expect((await theirs.closed).code).toBe(4401);
    // Their client went with them, so their next request is refused too.
    expect(
      (await get(core, "/api/people", { token: ben.token })).statusCode,
    ).toBe(401);
    expect(mine.socket.readyState).toBe(mine.socket.OPEN);
    mine.socket.terminate();
  });
});
