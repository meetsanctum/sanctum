import { afterEach, describe, expect, it, vi } from "vitest";

import { devicesSeenBy, lampsCore } from "./devices-support.js";
import { radio } from "./fixtures/apps/lamps/index.js";
import { post, sharedClient, type TestCore } from "./support.js";

// What's wrong with a device, in the words its driver declares, and Repair,
// with the lamps driver's pretend radio: a lamp whose key changed says so,
// and Repair hands the driver the key someone types, once.

const secret = "c2VjcmV0IGtleSBvZiB0aGUga2l0Y2hlbiBsYW1w";

afterEach(() => vi.restoreAllMocks());

function entries(core: TestCore, action: string) {
  return core.activity.recent().filter((entry) => entry.action === action);
}

async function problemOf(core: TestCore, token: string, id: string) {
  const devices = await devicesSeenBy(core, token);
  return devices.find((device: { id: string }) => device.id === id).problem;
}

describe("a device's problem", () => {
  it("is in its driver's declared words, with what Repair asks, until the driver clears it", async () => {
    const { core, maya, lamp } = await lampsCore();

    await radio.rekey("lamp-1", secret);

    expect(await problemOf(core, maya.token, lamp)).toEqual({
      id: "keyMismatch",
      words: "Its key doesn't match",
      repair: {
        help: "Enter the key on its label.",
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
      },
    });
    expect(entries(core, "device.problem")).toMatchObject([
      {
        outcome: "ok",
        subjectId: lamp,
        detail: { problem: "Its key doesn't match" },
      },
    ]);

    await radio.sayProblem("lamp-1", "loose");
    expect(await problemOf(core, maya.token, lamp)).toMatchObject({
      id: "loose",
      repair: null,
    });
    await radio.sayProblem("lamp-1", null);
    expect(await problemOf(core, maya.token, lamp)).toBeNull();
  });

  it("is one the driver declares, for a device it has", async () => {
    await lampsCore();

    await expect(radio.sayProblem("lamp-1", "unheardOf")).rejects.toThrow(
      /declares no problem unheardOf/,
    );
    await expect(radio.sayProblem("lamp-9", "loose")).rejects.toThrow();
  });
});

describe("Repair", () => {
  const repair = (
    core: TestCore,
    who: { token: string },
    body: Record<string, unknown>,
  ) => post(core, "/api/devices/repair", body, who);

  it("hands the driver the answer once, and shows the refusal it declares", async () => {
    const { core, maya, lamp } = await lampsCore();
    await radio.rekey("lamp-1", secret);

    const wrong = await repair(core, maya, {
      id: lamp,
      answers: { key: "not the key" },
    });
    expect(wrong.statusCode).toBe(200);
    expect(wrong.json()).toEqual({
      refused: { question: "key", refusal: "wrongKey" },
    });
    expect(await problemOf(core, maya.token, lamp)).toMatchObject({
      id: "keyMismatch",
    });

    const right = await repair(core, maya, {
      id: lamp,
      answers: { key: secret },
    });
    expect(right.statusCode).toBe(200);
    expect(right.json().repaired).toMatchObject({ id: lamp, problem: null });
    expect(radio.repairs.map(({ repair, actor }) => [repair, actor])).toEqual([
      [
        {
          key: "lamp-1",
          device: lamp,
          problem: "keyMismatch",
          answers: { key: "not the key" },
        },
        { kind: "user", id: maya.person.id },
      ],
      [
        {
          key: "lamp-1",
          device: lamp,
          problem: "keyMismatch",
          answers: { key: secret },
        },
        { kind: "user", id: maya.person.id },
      ],
    ]);
    expect(entries(core, "device.repair")).toMatchObject([
      { outcome: "ok", subjectId: lamp, personId: maya.person.id },
      { outcome: "refused", reason: "wrongKey", subjectId: lamp },
    ]);
    // The answers are in no log and no entry.
    const said = JSON.stringify(core.activity.recent()) + core.logs.join("\n");
    expect(said).not.toContain(secret);
    expect(said).not.toContain("not the key");
  });

  it("is for every client, a shared one too", async () => {
    const { core, lamp } = await lampsCore();
    await radio.rekey("lamp-1", secret);

    const repaired = await repair(core, sharedClient(core), {
      id: lamp,
      answers: { key: secret },
    });

    expect(repaired.statusCode).toBe(200);
    expect(repaired.json().repaired.problem).toBeNull();
  });

  it.each([
    ["no answer", {}],
    ["an empty answer", { key: "" }],
    ["an answer to something it doesn't ask", { key: secret, name: "x" }],
  ])("refuses %s without asking the driver", async (_what, answers) => {
    const { core, maya, lamp } = await lampsCore();
    await radio.rekey("lamp-1", secret);

    const refused = await repair(core, maya, { id: lamp, answers });

    expect(refused.statusCode).toBe(400);
    expect(radio.repairs).toEqual([]);
  });

  it("refuses a device with nothing to repair", async () => {
    const { core, maya, lamp, plug } = await lampsCore();
    await radio.sayProblem("plug-1", "loose");

    const fine = await repair(core, maya, { id: lamp, answers: {} });
    const loose = await repair(core, maya, { id: plug, answers: {} });
    const missing = await repair(core, maya, { id: "nope", answers: {} });

    expect(fine.statusCode).toBe(409);
    expect(loose.statusCode).toBe(409);
    expect(missing.statusCode).toBe(404);
    expect(radio.repairs).toEqual([]);
  });

  it("fails when the driver refuses in words it doesn't declare, logging no answer", async () => {
    const { core, maya, lamp } = await lampsCore();
    await radio.rekey("lamp-1", secret);
    radio.repairRefusesOddly = true;

    const failed = await repair(core, maya, {
      id: lamp,
      answers: { key: secret },
    });

    expect(failed.statusCode).toBe(500);
    expect(entries(core, "device.repair")).toMatchObject([
      { outcome: "failed", reason: "app_failed" },
    ]);
    expect(core.logs.join("\n")).not.toContain(secret);
  });

  it("takes turns with removing the device", async () => {
    const { core, maya, lamp } = await lampsCore();
    await radio.rekey("lamp-1", secret);
    radio.repairMs = 50;

    const repairing = repair(core, maya, {
      id: lamp,
      answers: { key: secret },
    });
    const removing = post(core, "/api/devices/remove", { id: lamp }, maya);
    const [repaired, removed] = await Promise.all([repairing, removing]);

    expect(repaired.statusCode).toBe(200);
    expect(removed.statusCode).toBe(200);
    expect(radio.turns).toEqual([
      "repair lamp-1",
      "repaired lamp-1",
      "remove lamp-1",
    ]);
  });

  it.each([secret, {}, false, null])(
    "rejects a malformed driver result without logging its contents (%j)",
    async (result) => {
      const { core, maya, lamp } = await lampsCore();
      await radio.rekey("lamp-1", secret);
      vi.spyOn(radio, "repair").mockResolvedValue(result as never);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      const failed = await repair(core, maya, {
        id: lamp,
        answers: { key: secret },
      });

      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({ error: "app_failed" });
      expect(entries(core, "device.repair")).toMatchObject([
        { outcome: "failed", reason: "app_failed" },
      ]);
      expect(errors).not.toHaveBeenCalled();
      expect(
        JSON.stringify(core.activity.recent()) + core.logs.join("\n"),
      ).not.toContain(secret);
    },
  );
});
