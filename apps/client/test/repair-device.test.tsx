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
});
