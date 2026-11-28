// @vitest-environment jsdom
import type {
  DeviceInfo,
  DeviceQuestion,
  FoundDevice,
  PairingInfo,
} from "@meetsanctum/app-sdk";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { CoreError, coreFetch, coreJson } from "../src/core-fetch";
import { light, office } from "./settings-devices-fixtures";
import {
  admin,
  button,
  choose,
  container,
  devices,
  live,
  pairing,
  requests,
  setDevices,
  setPairing,
  show,
  type,
} from "./settings-devices-harness";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
  // Best-effort cleanup if the dialog unmounts with an attempt open.
  coreFetch: vi.fn(async () => new Response(null)),
}));

// Settings → Devices' category pages list what was found on the home's
// network of their kind, and add it in one dialog from Add to Done.

const found = (key: string, extra: Partial<FoundDevice> = {}): FoundDevice => ({
  driver: "sanctum.zigbee",
  key,
  name: key,
  description: null,
  type: "light",
  asks: [],
  later: [],
  refusals: {},
  ...extra,
});

const question = (
  id: string,
  extra: Partial<DeviceQuestion> = {},
): DeviceQuestion => ({
  id,
  label: "Encryption key",
  kind: "secret",
  help: "From its configuration.",
  placeholder: null,
  refusals: { wrongKey: "That key doesn't match." },
  length: null,
  lasts: null,
  ...extra,
});

function withFound(...list: FoundDevice[]) {
  setPairing({ ...pairing, found: list } satisfies PairingInfo);
}

function answerRoute(
  route: string,
  answer: (json: Record<string, unknown>) => unknown,
) {
  const base = vi.mocked(coreJson).getMockImplementation()!;
  vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
    if (path !== route) return base(path, init);
    requests.push({ path, json: init.json });
    return answer(init.json as Record<string, unknown>);
  });
}

const answerAdding = (answer: (json: Record<string, unknown>) => unknown) =>
  answerRoute("/api/devices/add", answer);

const addRequests = () =>
  requests.filter((each) => each.path === "/api/devices/add");

function register(device: DeviceInfo) {
  setDevices([...devices, device]);
  return { added: device };
}

function pendingReply<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
const field = () => dialog()!.querySelector<HTMLInputElement>("input")!;
const stepLabel = () => dialog()!.querySelector(".sr-only[id]")?.textContent;
const escape = (target: Element) =>
  act(async () =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
const segments = () => [
  ...document.querySelectorAll("[data-slot=step-segments] > span"),
];
const reached = () =>
  document.querySelectorAll("[data-slot=step-segments] > [data-reached]")
    .length;
// Presses a found device's Add, and waits for the dialog to start adding
// one that asks nothing first, which it does once it's there.
async function pressAdd(name: string) {
  await act(async () => addButton(name).click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

const addButton = (name: string) =>
  container.querySelector<HTMLButtonElement>(
    `button[aria-label^="Add ${name}"]`,
  )!;

describe("Devices found on a category's page", () => {
  it("lists those of its kind, quieter, and counts them on Devices", async () => {
    withFound(
      found("kitchen-bulb", { description: "Hue White A60" }),
      found("mystery", { type: null }),
    );
    await show(admin);
    const section = container.querySelector(
      "[aria-labelledby=settings-found-devices]",
    )!;
    expect(section.textContent).toContain("Found on Your Network");
    expect(section.textContent).toContain("kitchen-bulb");
    expect(section.textContent).toContain("Hue White A60 · Zigbee");
    expect(section.textContent).not.toContain("mystery");
    // Nothing under the page's title says it.
    expect(document.querySelector("#settings-devices > span")).toBeNull();
    // What it is is heard with its name.
    expect(addButton("kitchen-bulb").getAttribute("aria-label")).toBe(
      "Add kitchen-bulb, Hue White A60",
    );

    await show(admin, null);
    expect(container.textContent).toContain("1 found · 1 device");
    // A kind with nothing added yet shows while something of it was found.
    expect(container.textContent).toContain("Unknown Devices1 found");
  });

  it("shows only what was found on a page with nothing added", async () => {
    withFound(found("mystery", { type: null }));
    await show(admin, "unknown");
    expect(container.querySelector("h1")?.textContent).toBe("Unknown Devices");
    expect(container.textContent).toContain("mystery");
    expect(container.textContent).not.toContain("any more");
  });

  it("adds one that asks nothing from the press, then names it", async () => {
    withFound(found("kitchen-bulb"));
    answerAdding(() => register(light("bulb", "kitchen-bulb")));
    await show(admin);

    await pressAdd("kitchen-bulb");
    expect(
      requests.filter((each) => each.path === "/api/devices/add"),
    ).toHaveLength(1);
    // Adding, then naming: two steps, both reached.
    expect(dialog()!.querySelector("h2")?.textContent).toBe("Added to Lights");
    expect(segments()).toHaveLength(2);
    expect(reached()).toBe(2);
    expect(dialog()!.textContent).toContain("Name it and choose its room.");

    const name = dialog()!.querySelector<HTMLInputElement>("input")!;
    await type(name, "Kitchen Light");
    await act(async () => name.blur());
    expect(requests.at(-1)).toEqual({
      path: "/api/devices/update",
      json: { id: "bulb", name: "Kitchen Light" },
    });

    await act(async () => button("Done").click());
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain("Kitchen Light");
  });

  it("keeps the first device's add dialog open through live registration", async () => {
    // Its app asks some devices more once started, but not this one.
    withFound(
      found("garage", { asks: [question("key")], later: ["first", "second"] }),
    );
    setDevices([]);
    const reply = pendingReply<{ added: DeviceInfo }>();
    answerAdding(() => reply.promise);
    await show(admin);

    await pressAdd("garage");
    expect(dialog()!.querySelector("h2")?.textContent).toBe("Add garage");
    // The key, then naming it.
    expect(segments()).toHaveLength(2);
    expect(reached()).toBe(1);
    // Nothing is sent before it's answered, and it can't close by a click
    // beside it, only Cancel or Escape.
    expect(requests.some((each) => each.path === "/api/devices/add")).toBe(
      false,
    );
    expect(button("Add").disabled).toBe(true);
    expect(button("Close")).toBeUndefined();

    await type(dialog()!.querySelector<HTMLInputElement>("input")!, "secret");
    await act(async () => button("Add").click());
    expect(button("Adding…").getAttribute("aria-disabled")).toBe("true");
    expect(button("Adding…").disabled).toBe(false);
    expect(
      requests.find((each) => each.path === "/api/devices/add")?.json,
    ).toMatchObject({ answers: { key: "secret" } });
    const original = dialog();
    const added = light("garage", "garage");
    await act(async () =>
      live.publish({ type: "device", id: added.id, device: added }),
    );
    expect(dialog()).toBe(original);
    await act(async () => reply.resolve(register(added)));
    expect(dialog()!.querySelector("h2")?.textContent).toBe("Added to Lights");
    expect(stepLabel()).toBe("Step 2 of 2");
    expect(addRequests()).toHaveLength(1);
  });

  const apple = "sanctum.apple-home-devices";
  const tv = found("Living Room", {
    driver: apple,
    type: "media-player",
    description: "Apple TV 4K",
    later: ["airplayCode", "companionCode"],
  });
  const addedTv = light("tv", tv.name, {
    driver: apple,
    type: "media-player",
    capabilities: [],
  });
  const code = (id: string) =>
    question(id, { label: "Code on the TV", kind: "code", length: 4 });
  const prompt = (
    attempt: unknown,
    step: number,
    ...asks: DeviceQuestion[]
  ) => ({
    attempt,
    step,
    asks,
    withinMs: 180_000,
    lastsMs: null,
  });

  it("sends both TV codes and advances through their planned steps", async () => {
    setDevices([
      light("den", "Den TV", { type: "media-player", capabilities: [] }),
    ]);
    withFound(tv);
    answerAdding((json) => {
      if (json.step === undefined)
        return prompt(json.attempt, 1, code("airplayCode"));
      if (json.step === 1)
        return prompt(json.attempt, 2, code("companionCode"));
      return register(addedTv);
    });
    await show(admin, "media");

    await pressAdd("Living Room");
    // Two codes, then naming it.
    expect(segments()).toHaveLength(3);
    expect(reached()).toBe(1);
    // What it is is said once, under the title, so a screen reader hears
    // it with the dialog.
    expect(dialog()!.querySelector("h2")?.textContent).toBe("Add Living Room");
    expect(dialog()!.querySelector("p")?.textContent).toBe("Apple TV 4K");
    expect(dialog()!.textContent).toContain("Code on the TV");
    expect(button("Continue").disabled).toBe(true);

    const start = addRequests()[0]!.json as { attempt: string };
    await type(field(), "1234");
    await act(async () => button("Continue").click());
    expect(addRequests()[1]?.json).toEqual({
      driver: apple,
      key: tv.key,
      attempt: start.attempt,
      step: 1,
      answers: { airplayCode: "1234" },
    });
    expect(stepLabel()).toBe("Step 2 of 3");
    expect(reached()).toBe(2);
    expect(field().value).toBe("");
    await type(field(), "0042");
    await act(async () => button("Continue").click());
    expect(addRequests()[2]?.json).toEqual({
      driver: apple,
      key: tv.key,
      attempt: start.attempt,
      step: 2,
      answers: { companionCode: "0042" },
    });
    expect(reached()).toBe(3);
    expect(dialog()!.querySelector("h2")?.textContent).toBe("Added to Media");
    expect(field().value).toBe(tv.name);
  });

  it("keeps reached segments filled when adding again", async () => {
    withFound(tv);
    answerAdding((json) => {
      if (json.step === undefined)
        return prompt(json.attempt, 1, code("airplayCode"));
      if (json.step === 1)
        return prompt(json.attempt, 2, code("companionCode"));
      return { ended: "wrong" };
    });
    await show(admin, "media");
    await pressAdd(tv.name);

    await type(field(), "1234");
    await act(async () => button("Continue").click());
    expect(reached()).toBe(2);
    await type(field(), "0042");
    await act(async () => button("Continue").click());
    expect(reached()).toBe(2);

    await act(async () => button("Add again").click());
    expect(dialog()!.textContent).toContain("Code on the TV");
    expect(segments()).toHaveLength(3);
    expect(reached()).toBe(2);
  });

  it.each(["Cancel", "Escape"])(
    "%s waits for the core to cancel pairing",
    async (action) => {
      withFound(tv);
      answerAdding((json) => prompt(json.attempt, 1, code("airplayCode")));
      const reply = pendingReply<{ ended: "cancelled" }>();
      answerRoute("/api/devices/add/cancel", () => reply.promise);
      await show(admin, "media");
      await pressAdd(tv.name);

      if (action === "Escape") await escape(field());
      else await act(async () => button("Cancel").click());
      const start = addRequests()[0]!.json as { attempt: string };
      expect(requests.at(-1)).toEqual({
        path: "/api/devices/add/cancel",
        json: { driver: apple, key: tv.key, attempt: start.attempt },
      });
      expect(dialog()).not.toBeNull();
      expect(button("Stopping…").disabled).toBe(true);
      await act(async () => reply.resolve({ ended: "cancelled" }));
      expect(dialog()).toBeNull();
    },
  );

  it("shows the added device if pairing finishes while cancelling", async () => {
    withFound(tv);
    const pairingReply = pendingReply<{ added: DeviceInfo }>();
    answerAdding((json) => {
      if (json.step === undefined)
        return prompt(json.attempt, 1, code("airplayCode"));
      if (json.step === 1)
        return prompt(json.attempt, 2, code("companionCode"));
      return pairingReply.promise;
    });
    const cancelReply = pendingReply<{ added: DeviceInfo }>();
    answerRoute("/api/devices/add/cancel", () => cancelReply.promise);
    await show(admin, "media");
    await pressAdd(tv.name);

    await type(field(), "1234");
    await act(async () => button("Continue").click());
    await type(field(), "0042");
    await act(async () => button("Continue").click());
    await act(async () => button("Cancel").click());
    await act(async () => pairingReply.resolve(register(addedTv)));
    expect(button("Stopping…")).toBeDefined();
    await act(async () => cancelReply.resolve({ added: addedTv }));
    expect(dialog()!.querySelector("h2")?.textContent).toBe("Added to Media");
    expect(button("Done")).toBeDefined();
  });

  it("reports a cancellation error and retries the same attempt", async () => {
    withFound(tv);
    answerAdding((json) => prompt(json.attempt, 1, code("airplayCode")));
    const cancel = vi
      .fn()
      .mockRejectedValueOnce(new CoreError(504, "timeout"))
      .mockResolvedValueOnce({ ended: "cancelled" });
    answerRoute("/api/devices/add/cancel", cancel);
    await show(admin, "media");
    await pressAdd(tv.name);

    await act(async () => button("Cancel").click());
    expect(dialog()!.textContent).toContain("Couldn't stop adding Living Room");
    await act(async () => button("Cancel").click());
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancel.mock.calls[0]).toEqual(cancel.mock.calls[1]);
    expect(dialog()).toBeNull();
  });

  it("closes at once on Cancel while one that asks nothing is being added", async () => {
    withFound(found("kitchen-bulb"));
    // Its app never answers.
    answerAdding(() => pendingReply().promise);
    await show(admin);
    await pressAdd("kitchen-bulb");
    expect(button("Adding…")).toBeDefined();

    await act(async () => button("Cancel").click());
    expect(dialog()).toBeNull();
    // The attempt ends quietly as the dialog goes.
    expect(
      vi
        .mocked(coreFetch)
        .mock.calls.some(([path]) => path === "/api/devices/add/cancel"),
    ).toBe(true);
  });

  const bulb = light("bulb", "kitchen-bulb", { identify: true });
  const hall = { ...office, id: "hall", name: "Hall" };

  async function openPlacement() {
    withFound(found(bulb.name));
    answerAdding(() => register(bulb));
    await show(admin);
    await pressAdd(bulb.name);
  }

  it("blinks the added device without submitting the dialog", async () => {
    await openPlacement();
    await act(async () => button("Blink").click());
    expect(requests.at(-1)).toEqual({
      path: "/api/devices/identify",
      json: { id: bulb.id },
    });
    expect(button("Done")).toBeDefined();
  });

  it("keeps a newer live change when a placement save replies late", async () => {
    await openPlacement();
    const reply = pendingReply<DeviceInfo>();
    answerRoute("/api/devices/update", () => reply.promise);
    await choose(`${bulb.name}: room`, office.name);

    const renamed = { ...bulb, name: "Porch light" };
    await act(async () =>
      live.publish({ type: "device", id: bulb.id, device: renamed }),
    );
    await act(async () => reply.resolve({ ...bulb, roomId: office.id }));
    expect(field().value).toBe("Porch light");
    expect(button("No room")?.getAttribute("aria-label")).toBe(
      "Porch light: room",
    );
  });

  it.each(["Escape", "Done", "Close"])(
    "saves a focused edit on %s",
    async (action) => {
      await openPlacement();
      await act(async () => field().focus());
      await type(field(), "Kitchen Light");
      if (action === "Escape") await escape(field());
      else await act(async () => button(action).click());
      expect(dialog()).toBeNull();
      expect(
        requests.filter((each) => each.path === "/api/devices/update"),
      ).toEqual([
        {
          path: "/api/devices/update",
          json: { id: bulb.id, name: "Kitchen Light" },
        },
      ]);
      expect(container.textContent).toContain("Kitchen Light");
    },
  );

  it.each(["focused", "blurred"])(
    "keeps the dialog open if the %s name edit fails to save on Done",
    async (focus) => {
      await openPlacement();
      const reply = pendingReply<DeviceInfo>();
      const updated = { ...bulb, name: "Kitchen Light" };
      const save = vi
        .fn()
        .mockImplementationOnce(() => reply.promise)
        .mockResolvedValueOnce(updated);
      answerRoute("/api/devices/update", save);
      const name = field();
      await act(async () => name.focus());
      await type(name, updated.name);
      if (focus === "blurred") await act(async () => name.blur());
      await act(async () => button("Done").click());
      expect(save).toHaveBeenCalledExactlyOnceWith({
        id: bulb.id,
        name: updated.name,
      });
      expect(dialog()).not.toBeNull();

      await act(async () => reply.reject(new CoreError(504, "timeout")));
      expect(dialog()!.textContent).toContain("changes weren't saved");

      await act(async () => name.focus());
      await type(name, updated.name);
      await act(async () => button("Done").click());
      expect(dialog()).toBeNull();
      expect(container.textContent).toContain(updated.name);
    },
  );

  it("follows a live rename while the untouched name field has focus", async () => {
    await openPlacement();
    const name = field();
    await act(async () => name.focus());
    await act(async () =>
      live.publish({
        type: "device",
        id: bulb.id,
        device: { ...bulb, name: "Porch light" },
      }),
    );
    expect(name.value).toBe("Porch light");
    await act(async () => name.blur());
    expect(requests.some((each) => each.path === "/api/devices/update")).toBe(
      false,
    );
  });

  async function nameRoom() {
    await choose(`${bulb.name}: room`, "New room…");
    const roomField = dialog()!.querySelector<HTMLInputElement>(
      '[placeholder="New room"]',
    )!;
    await type(roomField, hall.name);
    return roomField;
  }

  it.each(["Escape", "Cancel"])(
    "%s leaves room naming and stops a late placement",
    async (action) => {
      await openPlacement();
      const reply = pendingReply<typeof hall>();
      answerRoute("/api/places/rooms/add", () => reply.promise);
      const roomField = await nameRoom();
      await act(async () => button("Add room").click());
      if (action === "Escape") await escape(roomField);
      else await act(async () => button("Cancel").click());
      expect(button("Done")).toBeDefined();
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        `${bulb.name}: room`,
      );

      await choose(`${bulb.name}: room`, office.name);
      await act(async () => reply.resolve(hall));
      expect(
        requests.filter((each) => each.path === "/api/devices/update"),
      ).toEqual([
        {
          path: "/api/devices/update",
          json: { id: bulb.id, roomId: office.id },
        },
      ]);
      expect(button("Office")).toBeDefined();
    },
  );

  it("reuses the created room after a failed move", async () => {
    await openPlacement();
    answerRoute("/api/places/rooms/add", () => hall);
    const move = vi
      .fn()
      .mockRejectedValueOnce(new CoreError(504, "timeout"))
      .mockResolvedValueOnce({ ...bulb, roomId: hall.id });
    answerRoute("/api/devices/update", move);
    await nameRoom();
    await act(async () => button("Add room").click());
    expect(dialog()!.textContent).toContain("changes weren't saved");
    await act(async () => button("Add room").click());
    expect(button("Hall")).toBeDefined();
    expect(
      requests.filter((each) => each.path === "/api/places/rooms/add"),
    ).toHaveLength(1);
    expect(move.mock.calls).toEqual([
      [{ id: bulb.id, roomId: hall.id }],
      [{ id: bulb.id, roomId: hall.id }],
    ]);
  });

  it("says why it couldn't add one, and tries again", async () => {
    withFound(found("kitchen-bulb"));
    let tries = 0;
    answerAdding(() => {
      tries += 1;
      if (tries === 1) throw new CoreError(504, "timeout");
      return { added: light("bulb", "kitchen-bulb") };
    });
    await show(admin);

    await pressAdd("kitchen-bulb");
    expect(dialog()!.textContent).toContain("Couldn't add kitchen-bulb");
    expect(dialog()!.textContent).toContain(
      "Zigbee didn't answer in time. Try again in a moment.",
    );
    await act(async () => button("Try again").click());
    expect(dialog()!.querySelector("h2")?.textContent).toBe("Added to Lights");
  });
});
