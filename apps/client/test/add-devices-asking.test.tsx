// @vitest-environment jsdom
import type { DeviceAsking, FoundDevice } from "@meetsanctum/app-sdk";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import * as coreFetch from "../src/core-fetch";
import {
  core,
  kitchenSensor,
  named,
  page,
  root,
  show,
  type,
  way,
} from "./add-devices-support";
import { light } from "./settings-devices-fixtures";

// A found device whose adding asks once started, as a TV shows a first code
// once pairing begins, then a second one that lasts 35 seconds.

const code = {
  kind: "code" as const,
  length: 4,
  help: "The TV shows a four-digit code.",
  placeholder: null,
  refusals: { wrongCode: "That code didn't match." },
  lasts: null,
};
const first = { ...code, id: "first", label: "Code on the TV (1 of 2)" };
const second = {
  ...code,
  id: "second",
  label: "Code on the TV (2 of 2)",
  help: "A new code is on the TV.",
  lasts: { seconds: 35, again: "Show a new code" },
};
const tv: FoundDevice = {
  driver: "sanctum.example",
  key: "tv",
  name: "Living Room",
  description: "Apple TV",
  type: null,
  asks: [],
  refusals: {},
};

const asking = (step: number, asks: DeviceAsking["asks"]): DeviceAsking => ({
  attempt: "ignored",
  step,
  asks,
  withinMs: 180_000,
  lastsMs: asks.some((each) => each.lasts) ? 35_000 : null,
});

const button = (text: string) =>
  [...page().querySelectorAll("button")].find(
    (each) => each.textContent === text,
  )!;
const field = () => page().querySelector<HTMLInputElement>("input")!;

async function addTv() {
  core.adding = { ...core.adding, found: [tv] };
  await show();
  await way("Devices found");
  await act(async () => named("Add Living Room").click());
}

describe("Add devices, adding a device that asks once started", () => {
  it("asks each code in turn on its card, then adds it", async () => {
    const steps = [asking(1, [first]), asking(2, [second])];
    core.answers.tv = () =>
      steps.shift() ?? { added: light("tv", "Living Room") };

    await addTv();
    expect(field().inputMode).toBe("numeric");
    expect(field().autocomplete).toBe("off");
    expect(button("Continue").disabled).toBe(true);
    await type(field(), "123");
    expect(button("Continue").disabled).toBe(true);
    await type(field(), "1234");
    await act(async () => button("Continue").click());

    expect(page().textContent).toContain("Code on the TV (2 of 2)");
    expect(page().textContent).toContain(
      "A new code is on the TV. 35 s remaining",
    );
    await type(field(), "0042");
    await act(async () => button("Continue").click());

    const [start, ...answers] = core.requests.filter(
      (each) => each.path === "/api/devices/add",
    );
    const attempt = (start!.json as { attempt: string }).attempt;
    expect(attempt).toMatch(/^[0-9a-f-]{36}$/);
    expect(answers.map((each) => each.json)).toEqual([
      {
        driver: "sanctum.example",
        key: "tv",
        attempt: "ignored",
        step: 1,
        answers: { first: "1234" },
      },
      {
        driver: "sanctum.example",
        key: "tv",
        attempt: "ignored",
        step: 2,
        answers: { second: "0042" },
      },
    ]);
    expect(page().querySelector('[aria-label="Added"]')).not.toBeNull();
  });

  it("counts a code's time down and asks for a new one once it's up", async () => {
    const steps = [asking(1, [second]), asking(2, [second])];
    core.answers.tv = () => steps.shift();
    await addTv();
    await type(field(), "00");

    await act(async () => vi.advanceTimersByTime(27_000));
    expect(page().textContent).toContain("8 s remaining");
    await act(async () => vi.advanceTimersByTime(8_000));

    expect(page().textContent).toContain("Time to enter this code is up.");
    expect(field().value).toBe("");
    expect(field().disabled).toBe(true);
    await act(async () => button("Show a new code").click());
    expect(core.requests.at(-1)!.json).toMatchObject({
      step: 1,
      again: "second",
    });
    expect(page().textContent).toContain("35 s remaining");
  });

  it("shows a wrong code's refusal under its field, which empties", async () => {
    const steps = [
      asking(1, [first]),
      {
        ...asking(2, [first]),
        refused: { question: "first", refusal: "wrongCode" },
      },
    ];
    core.answers.tv = () => steps.shift();
    await addTv();
    await type(field(), "9999");
    await act(async () => button("Continue").click());

    expect(field().value).toBe("");
    expect(page().querySelector("[role=alert]")!.textContent).toBe(
      "That code didn't match.",
    );
  });

  it("says why adding stopped, and offers Add again", async () => {
    const steps: unknown[] = [asking(1, [first]), { ended: "replaced" }];
    core.answers.tv = () => steps.shift();
    await addTv();
    await type(field(), "1234");
    await act(async () => button("Continue").click());

    expect(page().textContent).toContain(
      "Adding was started again on another screen.",
    );
    expect(named("Add Living Room")).not.toBeNull();
  });

  it("stops after 3 minutes on its own", async () => {
    core.answers.tv = () => asking(1, [first]);
    await addTv();

    await act(async () => vi.advanceTimersByTime(180_000));

    expect(page().textContent).toContain(
      "Adding stopped after 3 minutes. Add it again when you're ready.",
    );
  });

  it("ends the attempt with Cancel, and as the overlay goes", async () => {
    const sent = vi
      .spyOn(coreFetch, "coreFetch")
      .mockResolvedValue(new Response("{}"));
    core.answers.tv = () => asking(1, [first]);
    await addTv();

    await act(async () => button("Cancel").click());
    expect(core.requests.at(-1)).toMatchObject({
      path: "/api/devices/add/cancel",
      json: { driver: "sanctum.example", key: "tv", attempt: "ignored" },
    });
    expect(named("Add Living Room")).not.toBeNull();

    await act(async () => named("Add Living Room").click());
    await act(async () => root.unmount());
    expect(sent).toHaveBeenCalledWith("/api/devices/add/cancel", {
      method: "POST",
      json: expect.objectContaining({ key: "tv", attempt: expect.any(String) }),
      keepalive: true,
    });
  });

  it("keeps Done outlined while a card asks", async () => {
    core.adding = { ...core.adding, found: [...core.adding.found, tv] };
    core.answers.kitchen = () => ({ added: kitchenSensor() });
    core.answers.tv = () => asking(1, [first]);
    await show();
    await way("Devices found");
    const done = () =>
      [...document.querySelectorAll("[role=dialog] button")]
        .find((each) => each.textContent === "Done")!
        .getAttribute("data-variant");

    await act(async () => named("Add Kitchen sensor").click());
    expect(done()).toBe("default");
    await act(async () => named("Add Living Room").click());
    expect(done()).toBe("outline");
    await act(async () => button("Cancel").click());
    expect(done()).toBe("default");
  });
});
