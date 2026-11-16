import { afterEach, describe, expect, it, vi } from "vitest";

import { lampsCore, openLive, radio, settled } from "./devices-support.js";
import { get, post, sharedClient, type TestCore } from "./support.js";

// The devices a driver found and could add, and adding one, with the lamps
// driver's pretend radio: it hears lamps nearby, one with a key on its label,
// and adds one when asked, once its key matches.

const secret = "c2VjcmV0IGtleSBvZiB0aGUgaGFsbCBsYW1w";

afterEach(() => vi.restoreAllMocks());

const hallLamp = { key: "lamp-7", name: "Hall lamp", type: "light" };
const porchLamp = {
  key: "lamp-8",
  name: "Porch lamp",
  description: "needs the key on its label",
  asks: ["key"],
};

const tooLate = "It stopped listening. Turn it off and on again, then add it.";

function entries(core: TestCore, action: string) {
  return core.activity.recent().filter((entry) => entry.action === action);
}

async function foundBy(core: TestCore, who: { token: string }) {
  return (await get(core, "/api/devices/pairing", who)).json().found;
}

const add = (
  core: TestCore,
  who: { token: string },
  body: Record<string, unknown>,
) => post(core, "/api/devices/add", body, who);

describe("found devices", () => {
  it("show what adding each asks, in its driver's words, leaving out those the home has", async () => {
    const { core, maya } = await lampsCore();
    const live = await openLive(core, maya.token);

    await radio.sayFound([
      hallLamp,
      porchLamp,
      // The home has it already.
      { key: "lamp-1", name: "Kitchen lamp" },
    ]);
    await settled();

    expect(await foundBy(core, maya)).toEqual([
      {
        driver: "test.lamps",
        key: "lamp-7",
        name: "Hall lamp",
        description: null,
        type: "light",
        asks: [],
        refusals: { tooLate },
      },
      {
        driver: "test.lamps",
        key: "lamp-8",
        name: "Porch lamp",
        description: "needs the key on its label",
        type: null,
        asks: [
          {
            id: "key",
            label: "Key",
            kind: "secret",
            help: null,
            placeholder: "On its label",
            refusals: { wrongKey: "That key doesn't match. Check its label." },
          },
        ],
        refusals: { tooLate },
      },
    ]);
    const told = live.messages.filter((each) => each.type === "pairing");
    expect(told.at(-1)).toMatchObject({
      pairing: { drivers: ["test.lamps"], found: [{ key: "lamp-7" }, {}] },
    });

    // A new list replaces the last.
    await radio.sayFound([porchLamp]);
    expect(
      (await foundBy(core, maya)).map((each: { key: string }) => each.key),
    ).toEqual(["lamp-8"]);
  });

  it("are only ones whose questions the driver declares, listed once", async () => {
    await lampsCore();

    await expect(
      radio.sayFound([{ ...porchLamp, asks: ["colour"] }]),
    ).rejects.toThrow();
    await expect(radio.sayFound([hallLamp, hallLamp])).rejects.toThrow();
  });

  it("go with the driver's run", async () => {
    const { core, maya } = await lampsCore();
    await radio.sayFound([hallLamp]);

    await core.apps.close();

    expect(await foundBy(core, maya)).toEqual([]);
    expect(
      (await add(core, maya, { driver: "test.lamps", key: "lamp-7" })).json(),
    ).toEqual({ error: "unavailable" });
  });
});

describe("adding a found device", () => {
  it("has the driver register it, which then leaves what was found", async () => {
    const { core, maya } = await lampsCore();
    await radio.sayFound([hallLamp, porchLamp]);

    const added = await add(core, maya, {
      driver: "test.lamps",
      key: "lamp-7",
    });

    expect(added.statusCode).toBe(200);
    const device = added.json().added;
    expect(device).toMatchObject({
      driver: "test.lamps",
      driverName: "Hall lamp",
    });
    expect(radio.adds).toEqual([
      {
        add: { key: "lamp-7", answers: {} },
        actor: { kind: "user", id: maya.person.id },
      },
    ]);
    expect(
      (await foundBy(core, maya)).map((each: { key: string }) => each.key),
    ).toEqual(["lamp-8"]);
    expect(entries(core, "device.add")).toMatchObject([
      {
        outcome: "ok",
        subjectId: device.id,
        personId: maya.person.id,
        detail: { name: device.name },
      },
    ]);
  });

  it("hands the driver the answer once, and shows the refusal it declares", async () => {
    const { core, maya } = await lampsCore();
    radio.keys.set("lamp-8", secret);
    await radio.sayFound([porchLamp]);

    const wrong = await add(core, maya, {
      driver: "test.lamps",
      key: "lamp-8",
      answers: { key: "not the key" },
    });
    expect(wrong.json()).toEqual({
      refused: { question: "key", refusal: "wrongKey" },
    });
    expect(await foundBy(core, maya)).toHaveLength(1);

    const right = await add(core, maya, {
      driver: "test.lamps",
      key: "lamp-8",
      answers: { key: secret },
    });
    expect(right.json().added).toMatchObject({ driverName: "Porch lamp" });
    expect(entries(core, "device.add")).toMatchObject([
      { outcome: "ok", detail: { name: right.json().added.name } },
      {
        outcome: "refused",
        reason: "wrongKey",
        detail: { name: "Porch lamp" },
      },
    ]);
    // The answers are in no log and no entry.
    const said = JSON.stringify(core.activity.recent()) + core.logs.join("\n");
    expect(said).not.toContain(secret);
    expect(said).not.toContain("not the key");
  });

  it("shows the refusal its driver declares of adding it at all, and fails one it doesn't", async () => {
    const { core, maya } = await lampsCore();
    await radio.sayFound([hallLamp]);
    radio.refusesAdding.set("lamp-7", "tooLate");

    const late = await add(core, maya, {
      driver: "test.lamps",
      key: "lamp-7",
      answers: {},
    });
    expect(late.json()).toEqual({ refused: { refusal: "tooLate" } });
    expect(entries(core, "device.add")).toMatchObject([
      { outcome: "refused", reason: "tooLate", detail: { name: "Hall lamp" } },
    ]);
    expect(await foundBy(core, maya)).toHaveLength(1);

    radio.refusesAdding.set("lamp-7", "busy");
    const odd = await add(core, maya, {
      driver: "test.lamps",
      key: "lamp-7",
      answers: {},
    });
    expect(odd.statusCode).toBe(500);
    expect(odd.json()).toMatchObject({ error: "app_failed" });
  });

  it("is for every client, a shared one too", async () => {
    const { core } = await lampsCore();
    await radio.sayFound([hallLamp]);

    const added = await add(core, sharedClient(core), {
      driver: "test.lamps",
      key: "lamp-7",
    });

    expect(added.json().added).toMatchObject({ driverName: "Hall lamp" });
  });

  it("gives the same device when it's added twice, asking the driver once", async () => {
    const { core, maya } = await lampsCore();
    await radio.sayFound([hallLamp]);
    radio.addMs = 30;

    const body = { driver: "test.lamps", key: "lamp-7" };
    const [first, second] = await Promise.all([
      add(core, maya, body),
      add(core, maya, body),
    ]);

    expect(first.json().added.id).toBe(second.json().added.id);
    expect(radio.adds).toHaveLength(1);
  });

  it("takes turns with removing the device", async () => {
    const { core, maya } = await lampsCore();
    await radio.sayFound([hallLamp]);
    radio.addMs = 30;

    const adding = add(core, maya, { driver: "test.lamps", key: "lamp-7" });
    await settled();
    // Registered while its add is under way, as a driver may do.
    await radio.add("lamp-7", "light", "Hall lamp");
    const id = (await get(core, "/api/devices", maya))
      .json()
      .find(
        (device: { driverName: string }) => device.driverName === "Hall lamp",
      ).id;
    const removing = post(core, "/api/devices/remove", { id }, maya);
    const [added, removed] = await Promise.all([adding, removing]);

    expect(added.statusCode).toBe(200);
    expect(removed.statusCode).toBe(200);
    expect(radio.turns).toEqual([
      "add lamp-7",
      "added lamp-7",
      "remove lamp-7",
    ]);
  });

  it("gives the driver longer than other calls", async () => {
    const { core, maya } = await lampsCore({ appTimeoutMs: 300 });
    await radio.sayFound([hallLamp]);
    radio.addMs = 400;

    const added = await add(core, maya, {
      driver: "test.lamps",
      key: "lamp-7",
    });

    expect(added.json().added).toMatchObject({ driverName: "Hall lamp" });
  });

  it.each([
    ["no answer", {}],
    ["an empty answer", { key: "" }],
    ["an answer to something it doesn't ask", { key: secret, name: "x" }],
  ])("refuses %s without asking the driver", async (_what, answers) => {
    const { core, maya } = await lampsCore();
    await radio.sayFound([porchLamp]);

    const refused = await add(core, maya, {
      driver: "test.lamps",
      key: "lamp-8",
      answers,
    });

    expect(refused.statusCode).toBe(400);
    expect(radio.adds).toEqual([]);
  });

  it("refuses a device nobody found", async () => {
    const { core, maya } = await lampsCore();
    await radio.sayFound([hallLamp]);

    const missing = await add(core, maya, {
      driver: "test.lamps",
      key: "lamp-9",
    });
    const elsewhere = await add(core, maya, {
      driver: "test.elsewhere",
      key: "lamp-7",
    });

    expect(missing.statusCode).toBe(404);
    expect(elsewhere.statusCode).toBe(404);
    expect(radio.adds).toEqual([]);
  });

  it("fails when the driver answers without registering it", async () => {
    const { core, maya } = await lampsCore();
    await radio.sayFound([hallLamp]);
    radio.addForgets = true;

    const failed = await add(core, maya, {
      driver: "test.lamps",
      key: "lamp-7",
    });

    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "app_failed" });
    expect(entries(core, "device.add")).toMatchObject([
      {
        outcome: "failed",
        reason: "app_failed",
        detail: { name: "Hall lamp" },
      },
    ]);
  });

  it.each([
    secret,
    {},
    false,
    { refused: { question: "key", refusal: "tooShort" } },
  ])(
    "rejects a driver result it can't take without logging its contents (%j)",
    async (result) => {
      const { core, maya } = await lampsCore();
      await radio.sayFound([porchLamp]);
      vi.spyOn(radio, "addFound").mockResolvedValue(result as never);

      const failed = await add(core, maya, {
        driver: "test.lamps",
        key: "lamp-8",
        answers: { key: secret },
      });

      expect(failed.statusCode).toBe(500);
      expect(entries(core, "device.add")).toMatchObject([
        { outcome: "failed", reason: "app_failed" },
      ]);
      expect(
        JSON.stringify(core.activity.recent()) + core.logs.join("\n"),
      ).not.toContain(secret);
    },
  );
});
