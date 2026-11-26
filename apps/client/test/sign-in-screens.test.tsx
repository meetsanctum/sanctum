// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";
import type { FoundHost, Shell } from "../src/shell";

const office: FoundHost = {
  id: "6b0f6f4e-2a52-4f8e-9a51-1d1d1f6e6e73",
  homeId: "0d5c1f0a-7a43-4b6e-8f0e-2f6a0c9b1e55",
  name: "Office",
  claimed: true,
  url: "https://192.168.7.222:4100",
};
const unclaimed: FoundHost = {
  id: "2c1d6a8e-3b7f-4c2a-9e0d-5f8a7b6c4d3e",
  homeId: null,
  name: "sanctum",
  claimed: false,
  url: "https://192.168.7.223:4100",
};

let root: Root;
let container: HTMLDivElement;
let publish: (hosts: FoundHost[]) => void;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Nothing here reaches a core: choosing only moves between screens.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
  vi.stubGlobal("sanctumShell", {
    platform: "macos",
    deviceName: async () => "Mac",
    discovery: {
      watch: (onHosts) => {
        publish = onHosts;
        onHosts([]);
        return () => {};
      },
    },
    credentials: {
      isSecure: async () => true,
      load: async () => null,
      save: async () => {},
      forget: async () => {},
    },
    trust: null,
    preferences: { get: async () => null, set: async () => {} },
  } satisfies Shell);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
  await wait(0);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const title = () => container.querySelector("h1")?.textContent;
const buttons = () => [...container.querySelectorAll("button")];

async function click(text: string) {
  const found = buttons().find((each) => each.textContent!.includes(text));
  expect(found, text).toBeDefined();
  await act(async () => found!.click());
  await wait(0);
}

describe("choosing a home", () => {
  it("shows the rows' shapes while it looks, then a check list once nothing answers", async () => {
    expect(title()).toBe("Choose your home");
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Looking for homes…",
    );

    await wait(6_000);

    expect(title()).toBe("No home found yet");
    expect(container.textContent).toContain(
      "This device is on your home Wi‑Fi, not a guest network.",
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Still looking…",
    );
  });

  it("lists a home by its name alone, and a new one as ready to set up", async () => {
    await act(async () => publish([office, unclaimed]));

    const rows = buttons().map((each) => each.textContent);
    expect(rows).toEqual(["Office", "New homeReady to set up"]);
    expect(container.textContent).not.toContain("192.168.7.222");
  });

  it("tells two homes of one name apart by their address", async () => {
    await act(async () =>
      publish([office, { ...office, id: "another", url: "https://10.0.0.9" }]),
    );

    expect(buttons().map((each) => each.textContent)).toEqual([
      "Office192.168.7.222",
      "Office10.0.0.9",
    ]);
  });
});

describe("who uses this device", () => {
  beforeEach(async () => {
    await act(async () => publish([office]));
    await click("Office");
  });

  it("asks before a home is signed in to, with both ways weighed the same", async () => {
    expect(title()).toBe("Who uses this device?");
    expect(container.textContent).toContain("This device joins Office.");
    const choices = buttons().filter((each) =>
      ["Just me", "Everyone at home"].some((name) =>
        each.textContent!.startsWith(name),
      ),
    );
    expect(choices.map((each) => each.dataset.variant)).toEqual([
      "tile",
      "tile",
    ]);
  });

  it("signs in for just me, and goes back to the question", async () => {
    await click("Just me");
    expect(title()).toBe("Sign in to Office");
    expect(container.querySelector('button[type="submit"]')).not.toBeNull();

    await click("Back");
    expect(title()).toBe("Who uses this device?");

    await click("Homes");
    expect(title()).toBe("Choose your home");
  });

  it("pairs a device everyone at home uses, with no password field", async () => {
    await click("Everyone at home");
    expect(title()).toBe("Add this device to Office");
    expect(container.querySelector('input[type="password"]')).toBeNull();

    await click("Back");
    expect(title()).toBe("Who uses this device?");
  });
});
