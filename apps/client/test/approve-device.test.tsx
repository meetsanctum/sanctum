// @vitest-environment jsdom
import type {
  PairExchangeFailure,
  PairExchangeStatus,
} from "@meetsanctum/auth-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApproveDevice } from "../src/approve-device";
import { CoreError, coreJson } from "../src/core-fetch";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

// Adding a shared device from Settings → Clients: type its code, wait while
// the home checks the device, then name and approve it.

const started = { requestId: "request-1", exchangeId: "exchange-1" };
const lenovo = {
  platform: "android",
  suggestedName: "Lenovo Tab",
  createdAt: "2026-10-28T11:58:00Z",
  expiresAt: "2026-10-28T12:08:00Z",
} as const;

let root: Root;
let container: HTMLDivElement;
let approved: unknown[];
let looked: unknown[];
// What the exchange says each time it is asked, the last one repeating.
let statuses: PairExchangeStatus[];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  approved = [];
  looked = [];
  statuses = [{ status: "verified", request: lenovo }];
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
    switch (path) {
      case "/api/auth/pair/lookup":
        looked.push(init.json);
        if ((init.json as { code: string }).code.slice(0, 2) !== "K7") {
          throw new CoreError(404, "not_found");
        }
        return started;
      case "/api/auth/pair/exchange":
        expect(init.json).toEqual(started);
        return statuses.length > 1 ? statuses.shift() : statuses[0];
      case "/api/auth/pair/approve":
        approved.push(init.json);
        return undefined;
      default:
        throw new Error(`Unexpected request: ${path}`);
    }
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await open();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open(isOpen = true) {
  await act(async () =>
    root.render(
      <ApproveDevice
        open={isOpen}
        onOpenChange={(next) => void open(next)}
        onApproved={() => {}}
      />,
    ),
  );
}

function dialog() {
  return document.querySelector<HTMLElement>("[role=dialog]")!;
}

function button(name: string) {
  return [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  )!;
}

// Sets an input's value the way typing does, so React sees it.
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function find(code: string, waitMs = 0) {
  await type(dialog().querySelector("input")!, code);
  await act(async () => button("Find the device").click());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(waitMs);
  });
}

describe("adding a shared device", () => {
  it("checks the device behind a typed code, then names and approves it", async () => {
    statuses = [
      { status: "exchanging" },
      { status: "exchanging" },
      { status: "verified", request: lenovo },
    ];
    await type(dialog().querySelector("input")!, "k7qx-m4pd");
    await act(async () => button("Find the device").click());

    expect(looked).toEqual([{ code: "K7QXM4PD" }]);
    expect(button("Finding the device…")).toBeDefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(dialog().textContent).toContain("Approve this device?");
    expect(dialog().textContent).toContain(
      "Anyone who uses it can see and control everything in the home, without signing in.",
    );
    expect(dialog().textContent).toContain("Lenovo Tab");
    expect(dialog().textContent).toContain("Android · Code K7QX-M4PD");
    expect(dialog().textContent).not.toContain("certificate");
    const name = dialog().querySelector<HTMLInputElement>("input")!;
    expect(name.value).toBe("Lenovo Tab");

    await type(name, "Kitchen Tablet");
    await act(async () => button("Approve").click());

    expect(approved).toEqual([{ ...started, name: "Kitchen Tablet" }]);
    expect(dialog().textContent).toContain("Kitchen Tablet is approved");
    expect(dialog().textContent).toContain(
      "It shows the home’s dashboard in a few seconds.",
    );
  });

  it("names a browser by its kind once, and leaves its name to fill in", async () => {
    statuses = [
      {
        status: "verified",
        request: { ...lenovo, platform: "web", suggestedName: "Web browser" },
      },
    ];
    await find("K7QX-M4PD");

    expect(dialog().textContent).toContain("Web browserCode K7QX-M4PD");
    expect(dialog().textContent).not.toContain("Web browser · Web browser");
    const name = dialog().querySelector<HTMLInputElement>("input")!;
    expect(name.value).toBe("");
    expect(name.placeholder).toBe("Living Room Display");
    expect(button("Approve").disabled).toBe(true);
  });

  it.each<[PairExchangeFailure, string]>([
    ["wrong_code", "That code doesn’t match the one on the device."],
    ["no_answer", "The device didn’t answer."],
    ["unchecked", "Sanctum couldn’t check this device, so it can’t join."],
    [
      "channel_mismatch",
      "This device isn’t connected to Sanctum directly, so it can’t join.",
    ],
  ])(
    "says why an exchange that ends with %s didn't check the device",
    async (reason, text) => {
      statuses = [{ status: "failed", reason }];
      await find("K7QX-M4PD");

      expect(dialog().querySelector("[role=alert]")!.textContent).toContain(
        text,
      );
      expect(dialog().textContent).toContain("Find the device");
      expect(approved).toEqual([]);
    },
  );

  it("stops waiting for a device that never answers", async () => {
    statuses = [{ status: "exchanging" }];
    await find("K7QX-M4PD", 75_000);

    expect(dialog().querySelector("[role=alert]")!.textContent).toContain(
      "The device didn’t answer.",
    );
  });

  it("aborts a pending status request at the deadline and lets the user retry", async () => {
    const original = vi.mocked(coreJson).getMockImplementation()!;
    let pending: AbortSignal | null | undefined;
    vi.mocked(coreJson).mockImplementation((path, init) => {
      if (path !== "/api/auth/pair/exchange") return original(path, init);
      const signal = init!.signal!;
      pending = signal;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });
    await find("K7QX-M4PD", 74_999);
    expect(pending?.aborted).toBe(false);
    expect(button("Finding the device…").disabled).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(1));

    expect(pending?.aborted).toBe(true);
    expect(dialog().querySelector("[role=alert]")!.textContent).toContain(
      "The device didn’t answer.",
    );
    expect(button("Find the device").disabled).toBe(false);
  });

  it("says when no device shows a code, naming the code", async () => {
    await find("W3RT-9HNC");

    expect(dialog().querySelector("[role=alert]")!.textContent).toBe(
      "No device is showing W3RT-9HNC. Its code changes every 10 minutes, so check the one it shows now.",
    );
  });

  it("checks a code's form before asking the home", async () => {
    await find("K7QX-M4P0");

    expect(dialog().querySelector("[role=alert]")!.textContent).toContain(
      "8 letters and digits",
    );
    expect(looked).toEqual([]);
  });

  it("ignores a lookup from an approval dialog that was closed", async () => {
    const original = vi.mocked(coreJson).getMockImplementation()!;
    let finishLookup!: (value: unknown) => void;
    vi.mocked(coreJson).mockImplementation((path, init) =>
      path === "/api/auth/pair/lookup"
        ? new Promise((resolve) => {
            finishLookup = resolve;
          })
        : original(path, init),
    );
    await type(dialog().querySelector("input")!, "K7QX-M4PD");
    await act(async () => button("Find the device").click());
    await open(false);
    await open(true);

    await act(async () => finishLookup(started));

    expect(dialog().textContent).toContain("Find the device");
    expect(dialog().textContent).not.toContain("Approve this device?");
  });

  it("ignores an approval response after going back", async () => {
    const original = vi.mocked(coreJson).getMockImplementation()!;
    let finishApproval!: (value: unknown) => void;
    vi.mocked(coreJson).mockImplementation((path, init) =>
      path === "/api/auth/pair/approve"
        ? new Promise((resolve) => {
            finishApproval = resolve;
          })
        : original(path, init),
    );
    await find("K7QX-M4PD");
    await act(async () => button("Approve").click());
    await act(async () => button("Back").click());
    await act(async () => finishApproval(undefined));

    expect(dialog().textContent).toContain("Find the device");
    expect(button("Find the device").disabled).toBe(false);
  });

  it("resumes the verified exchange when the approver reopens the dialog and enters the same code", async () => {
    await find("K7QX-M4PD");
    await open(false);
    await open(true);
    await find("K7QX-M4PD");
    await act(async () => button("Approve").click());

    expect(looked).toEqual([{ code: "K7QXM4PD" }]);
    expect(approved).toEqual([{ ...started, name: "Lenovo Tab" }]);
  });
});
