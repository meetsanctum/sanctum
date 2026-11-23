// @vitest-environment jsdom
import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { CoreError } from "../src/core-fetch";
import {
  cards,
  core,
  key,
  live,
  kitchenSensor,
  named,
  page,
  plug,
  show,
  type,
  way,
} from "./add-devices-support";
import { light } from "./settings-devices-fixtures";

describe("Add devices, adding what drivers found", () => {
  it("shows each found device as a card, saying what it has or what adding it needs", async () => {
    await show();
    await way("Devices found");

    expect(document.querySelector("[role=dialog] h2")!.textContent).toBe(
      "Devices found",
    );
    expect(document.querySelector("[role=dialog]")!.textContent).toContain(
      "2 found",
    );
    expect(cards().map((card) => card.textContent)).toEqual([
      "Kitchen sensortemperature, humidity, motionAdd",
      "Living room plugneeds its encryption keyEncryption keyAddUnder api: encryption: key in its configuration.",
    ]);
    expect(named("Add Kitchen sensor")).not.toBeNull();
    // What to check for the rest stays along the bottom as the cards scroll.
    expect(page().closest("[data-slot=scroll-area]")).not.toBeNull();
    expect(
      document.querySelector("[role=dialog] [data-slot=overlay-footer]")!
        .textContent,
    ).toBe(
      "Don't see yours? Check it's switched on and connected to your Wi‑Fi.",
    );
    expect(page().textContent).not.toContain("Don't see yours?");
  });

  it("adds one that asks nothing at once, and has it named and placed", async () => {
    const added = kitchenSensor();
    core.answers.kitchen = () => ({ added });
    const changed = vi.fn();
    await show(changed);
    await way("Devices found");

    await act(async () => named("Add Kitchen sensor").click());

    expect(core.requests).toContainEqual({
      path: "/api/devices/add",
      json: { driver: "sanctum.example", key: "kitchen", answers: {} },
    });
    expect(changed).toHaveBeenCalledWith(added);
    // Gone from what was found, it keeps its place to be named.
    core.adding = { ...core.adding, found: [plug] };
    core.devices = [added];
    await act(async () =>
      live.publish({ type: "pairing", pairing: core.adding }),
    );
    await show(changed);
    expect(cards()).toHaveLength(2);
    expect(
      cards()[0]!.querySelector<HTMLInputElement>(
        'input[aria-label="Name for Kitchen sensor"]',
      )!.value,
    ).toBe("Kitchen sensor");
    expect(cards()[0]!.querySelector('[aria-label="Added"]')).not.toBeNull();
  });

  it("makes Done the primary action once one is added", async () => {
    core.answers.kitchen = () => ({ added: kitchenSensor() });
    await show();
    await way("Devices found");
    const done = () =>
      [...document.querySelectorAll<HTMLElement>("[role=dialog] button")].find(
        (button) => button.textContent === "Done",
      )!;
    expect(done().dataset.variant).toBe("outline");

    await act(async () => named("Add Kitchen sensor").click());
    expect(done().dataset.variant).toBe("default");
    // Still so after going back and returning to what was found.
    await act(async () => named("Back to Add devices").click());
    expect(done().dataset.variant).toBe("outline");
    await way("Devices found");
    expect(done().dataset.variant).toBe("default");
  });

  it("asks a key on its card, says why one is refused and keeps it to correct", async () => {
    core.answers["living-room"] = ({ answers }) =>
      (answers as { key: string }).key === "the right key"
        ? {
            added: light("plug-1", "Living room plug", {
              driver: "sanctum.example",
              driverName: "Living room plug",
            }),
          }
        : { refused: { question: "key", refusal: "wrongKey" } };
    await show();
    await way("Devices found");

    const field = page().querySelector<HTMLInputElement>(
      "input[type=password]",
    )!;
    expect(field.labels![0]!.textContent).toBe("Encryption key");
    // Nothing goes until it's answered.
    const send = named("Add Living room plug");
    expect(send.disabled).toBe(true);

    await type(field, "a wrong key");
    await act(async () => send.click());
    expect(page().querySelector("[role=alert]")!.textContent).toBe(
      "That key doesn't match. Copy it again.",
    );
    expect(field.value).toBe("a wrong key");
    expect(field.getAttribute("aria-invalid")).toBe("true");

    await type(field, "the right key");
    await act(async () => send.click());
    expect(
      core.requests.filter((each) => each.path === "/api/devices/add"),
    ).toEqual([
      {
        path: "/api/devices/add",
        json: {
          driver: "sanctum.example",
          key: "living-room",
          answers: { key: "a wrong key" },
        },
      },
      {
        path: "/api/devices/add",
        json: {
          driver: "sanctum.example",
          key: "living-room",
          answers: { key: "the right key" },
        },
      },
    ]);
    expect(page().querySelector("input[type=password]")).toBeNull();
    expect(page().querySelector('[aria-label="Added"]')).not.toBeNull();
  });

  it("keeps an add in progress when registration removes it from discovery", async () => {
    const added = kitchenSensor();
    let finish!: (result: { added: DeviceInfo }) => void;
    core.answers.kitchen = () => new Promise((resolve) => (finish = resolve));
    const changed = vi.fn();
    await show(changed);
    await way("Devices found");
    await act(async () => named("Add Kitchen sensor").click());

    // Registration reaches live clients before the add request finishes.
    core.adding = { ...core.adding, found: [plug] };
    core.devices = [added];
    await act(async () =>
      live.publish({ type: "pairing", pairing: core.adding }),
    );
    await show(changed);
    expect(named("Add Kitchen sensor")?.disabled).toBe(true);
    await act(async () => finish({ added }));

    expect(changed).toHaveBeenCalledWith(added);
    expect(
      page().querySelector('input[aria-label="Name for Kitchen sensor"]'),
    ).not.toBeNull();
    expect(page().querySelector('[aria-label="Added"]')).not.toBeNull();
  });

  it("sends only answers to the questions the driver currently asks", async () => {
    core.answers["living-room"] = () => ({
      refused: { question: "label", refusal: "wrongKey" },
    });
    await show();
    await way("Devices found");
    await type(
      page().querySelector<HTMLInputElement>("input[type=password]")!,
      "old key",
    );

    core.adding = {
      ...core.adding,
      found: [{ ...plug, asks: [{ ...key, id: "label", kind: "text" }] }],
    };
    await show();
    await type(
      page().querySelector<HTMLInputElement>("input[type=text]")!,
      "new answer",
    );
    await act(async () => named("Add Living room plug").click());

    expect(core.requests.at(-1)).toEqual({
      path: "/api/devices/add",
      json: {
        driver: "sanctum.example",
        key: "living-room",
        answers: { label: "new answer" },
      },
    });
  });

  it("can add after the driver stops asking questions", async () => {
    core.answers["living-room"] = () => ({
      added: light("plug-1", "Living room plug"),
    });
    await show();
    await way("Devices found");
    await type(
      page().querySelector<HTMLInputElement>("input[type=password]")!,
      "old key",
    );
    core.adding = { ...core.adding, found: [{ ...plug, asks: [] }] };
    await show();

    await act(async () => named("Add Living room plug").click());
    expect(core.requests.at(-1)).toEqual({
      path: "/api/devices/add",
      json: { driver: "sanctum.example", key: "living-room", answers: {} },
    });
    expect(page().querySelector('[aria-label="Added"]')).not.toBeNull();
  });

  it("says when adding didn't work", async () => {
    core.answers.kitchen = () => {
      throw new CoreError(504, "timeout");
    };
    await show();
    await way("Devices found");

    await act(async () => named("Add Kitchen sensor").click());

    expect(page().querySelector("[role=alert]")!.textContent).toBe(
      "It didn't answer in time. Check it's switched on, then try again.",
    );
    expect(named("Add Kitchen sensor").disabled).toBe(false);
  });

  it("says why its driver refused adding one that asks nothing", async () => {
    core.answers.kitchen = () => ({ refused: { refusal: "notWaiting" } });
    await show();
    await way("Devices found");

    await act(async () => named("Add Kitchen sensor").click());

    expect(page().querySelector("[role=alert]")!.textContent).toBe(
      "It stopped waiting for a key. Turn it off and on again, then add it.",
    );
    expect(named("Add Kitchen sensor").disabled).toBe(false);
  });
});
