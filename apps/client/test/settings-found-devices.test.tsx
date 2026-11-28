// @vitest-environment jsdom
import type {
  DeviceQuestion,
  FoundDevice,
  PairingInfo,
} from "@meetsanctum/app-sdk";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { CoreError, coreJson } from "../src/core-fetch";
import { light } from "./settings-devices-fixtures";
import {
  admin,
  button,
  container,
  pairing,
  requests,
  setPairing,
  show,
  type,
} from "./settings-devices-harness";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
  // Where an attempt is cancelled as its dialog closes.
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

// Answers adding as given, and every other request as the harness does.
function answerAdding(answer: (json: Record<string, unknown>) => unknown) {
  const base = vi.mocked(coreJson).getMockImplementation()!;
  vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
    if (path !== "/api/devices/add") return base(path, init);
    requests.push({ path, json: init.json });
    return answer(init.json as Record<string, unknown>);
  });
}

const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
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
    answerAdding(() => ({ added: light("bulb", "kitchen-bulb") }));
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
  });

  it("asks what its app asks first, in the same dialog", async () => {
    // Its app asks some devices more once started, but not this one.
    withFound(
      found("garage", { asks: [question("key")], later: ["first", "second"] }),
    );
    answerAdding(() => ({ added: light("garage", "garage") }));
    await show(admin);

    await pressAdd("garage");
    expect(dialog()!.querySelector("h2")?.textContent).toBe("Add garage");
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
    expect(
      requests.find((each) => each.path === "/api/devices/add")?.json,
    ).toMatchObject({ answers: { key: "secret" } });
    expect(dialog()!.querySelector("h2")?.textContent).toBe("Added to Lights");
    expect(reached()).toBe(2);
  });

  it("plans a segment for each step adding asks once started", async () => {
    const code = (id: string) =>
      question(id, { label: "Code on the TV", kind: "code", length: 4 });
    withFound(
      found("Living Room", {
        type: "media-player",
        description: "Apple TV 4K",
        later: ["first", "second"],
      }),
    );
    answerAdding((json) => ({
      attempt: json.attempt,
      step: 1,
      asks: [code("first")],
      withinMs: 180_000,
      lastsMs: null,
    }));
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

    await act(async () => button("Cancel").click());
    expect(dialog()).toBeNull();
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
