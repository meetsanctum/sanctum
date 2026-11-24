// @vitest-environment jsdom
import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { RepairDevice } from "../src/repair-device";
import { light } from "./settings-devices-fixtures";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const device: DeviceInfo = {
  ...light("lamp", "Lamp"),
  problem: {
    id: "keyMismatch",
    words: "Its key doesn't match",
    repair: {
      help: null,
      asks: [
        {
          id: "key",
          label: "Key",
          kind: "secret",
          help: null,
          placeholder: null,
          refusals: { wrongKey: "That key doesn't match." },
          length: null,
          lasts: null,
        },
      ],
    },
  },
};

let root: Root;
let container: HTMLDivElement;
const onClose = vi.fn();
const onRepaired = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function show(device?: DeviceInfo) {
  await act(async () =>
    root.render(
      <RepairDevice
        device={device}
        appName="Example"
        onClose={onClose}
        onRepaired={onRepaired}
      />,
    ),
  );
}

async function typeAnswer(value: string) {
  const input = document.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const submit = () =>
  [...document.querySelectorAll("button")].find(
    (each) => each.textContent === "Repair",
  )!;

describe("Repair's dialog", () => {
  it.each(["secret", "text"] as const)(
    "uses the field type for a %s answer",
    async (kind) => {
      const question = device.problem!.repair!.asks[0]!;
      await show({
        ...device,
        problem: {
          ...device.problem!,
          repair: { help: null, asks: [{ ...question, kind }] },
        },
      });

      expect(document.querySelector("input")!.type).toBe(
        kind === "secret" ? "password" : "text",
      );
    },
  );

  it("starts a declared question named toString with an empty answer", async () => {
    const question = device.problem!.repair!.asks[0]!;
    await show({
      ...device,
      problem: {
        ...device.problem!,
        repair: { help: null, asks: [{ ...question, id: "toString" }] },
      },
    });

    expect(document.querySelector("input")!.value).toBe("");
    expect(submit().disabled).toBe(true);
  });

  it("ignores an earlier response after closing and reopening the same device", async () => {
    let finish!: (value: { repaired: DeviceInfo }) => void;
    vi.mocked(coreJson).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await show(device);
    await typeAnswer("earlier answer");
    await act(async () => submit().click());

    await show();
    await show(device);
    expect(document.querySelector("input")!.value).toBe("");
    await typeAnswer("new answer");
    await act(async () => finish({ repaired: { ...device, problem: null } }));

    expect(onRepaired).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector("input")!.value).toBe("new answer");
    expect(submit().disabled).toBe(false);
  });

  it("asks each code once the repair has started, and ends it as the dialog closes", async () => {
    const lost: DeviceInfo = {
      ...device,
      problem: {
        id: "pairingLost",
        words: "Its pairing was removed",
        repair: { help: "Pair it again.", asks: [] },
      },
    };
    const code = {
      id: "first",
      label: "Code on the TV (1 of 2)",
      kind: "code" as const,
      length: 4,
      help: null,
      placeholder: null,
      refusals: {},
      lasts: null,
    };
    vi.mocked(coreJson)
      .mockResolvedValueOnce({
        attempt: "a",
        step: 1,
        asks: [code],
        withinMs: 180_000,
        lastsMs: null,
      })
      .mockResolvedValueOnce({ repaired: { ...lost, problem: null } });
    const sent = vi
      .spyOn(await import("../src/core-fetch"), "coreFetch")
      .mockResolvedValue(new Response("{}"));
    await show(lost);

    await act(async () => submit().click());
    const button = () =>
      [...document.querySelectorAll("button")].find(
        (each) => each.textContent === "Continue",
      )!;
    expect(button().disabled).toBe(true);
    await typeAnswer("1234");
    await act(async () => button().click());

    expect(
      vi.mocked(coreJson).mock.calls.map(([, init]) => init!.json),
    ).toEqual([
      { id: lost.id, answers: {}, attempt: expect.any(String) },
      { id: lost.id, attempt: "a", step: 1, answers: { first: "1234" } },
    ]);
    expect(onRepaired).toHaveBeenCalled();
    // Repaired, nothing is left to end.
    expect(sent).not.toHaveBeenCalled();

    vi.mocked(coreJson).mockResolvedValueOnce({
      attempt: "b",
      step: 1,
      asks: [code],
      withinMs: 180_000,
      lastsMs: null,
    });
    await show(lost);
    await act(async () => submit().click());
    await show();
    expect(sent).toHaveBeenCalledWith("/api/devices/repair/cancel", {
      method: "POST",
      json: { id: lost.id, attempt: expect.any(String) },
      keepalive: true,
    });
  });
});
