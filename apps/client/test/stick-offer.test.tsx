// @vitest-environment jsdom
import type {
  AvailableApp,
  HardwareOffer,
  LiveMessage,
} from "@meetsanctum/app-sdk";
import type { LiveListener } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { pluggedInWords, StickOffer } from "../src/stick-offer";

// A Zigbee stick plugged in brings up its app's add sheet on this client, and
// an answer anywhere ends it.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const zigbee: AvailableApp = {
  id: "sanctum.example",
  name: "Example",
  version: "1.0.0",
  summary: null,
  icon: null,
  requests: [],
  memory: 128,
  data: 256,
  adds: {
    devices: true,
    widgets: 0,
    roomSections: 0,
    devicePages: 0,
    pieces: 0,
  },
  shortfalls: [],
};

const offer: HardwareOffer = {
  id: "offer-1",
  app: "sanctum.example",
  sticks: [{ path: "/dev/serial/by-id/zbt-2", label: "ZBT-2" }],
};

let root: Root;
let host: HTMLDivElement;
let listeners: LiveListener[];
const live = {
  subscribe(listener: LiveListener) {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((each) => each !== listener);
    };
  },
};
const hear = (message: LiveMessage) =>
  act(async () => {
    for (const listener of listeners) listener.message?.(message);
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listeners = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init) => {
    if (path === "/api/hardware/offer") return { offer };
    if (path === "/api/apps/available") return [zigbee];
    return init?.method === "POST" ? {} : undefined;
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const show = () =>
  act(async () =>
    root.render(<StickOffer live={live} isOnline onAdded={() => undefined} />),
  );

const dialog = () => document.body.querySelector('[role="dialog"]');
const button = (name: string) =>
  [...document.body.querySelectorAll("button")].find(
    ({ textContent }) => textContent === name,
  );

describe("a stick plugged in", () => {
  it("opens its app's add sheet, saying what happened", async () => {
    await show();

    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog()!.textContent).toContain("A Zigbee stick was plugged in");
    expect(dialog()!.textContent).toContain("Add Example?");
  });

  it("says no for every client on Cancel", async () => {
    await show();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());

    await act(async () => button("Cancel")!.click());

    expect(coreJson).toHaveBeenCalledWith("/api/hardware/offer/dismiss", {
      method: "POST",
      json: { id: "offer-1" },
    });
    expect(dialog()).toBeNull();
  });

  it("closes once it ends on another client or is unplugged", async () => {
    await show();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());

    await hear({ type: "offer", offer: null });

    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(coreJson).not.toHaveBeenCalledWith(
      "/api/hardware/offer/dismiss",
      expect.anything(),
    );
  });

  it("waits while another sheet is open", async () => {
    const other = document.createElement("div");
    other.setAttribute("role", "dialog");
    document.body.append(other);
    await show();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.body.textContent).not.toContain("Add Example?");

    other.remove();

    await vi.waitFor(
      () => expect(document.body.textContent).toContain("Add Example?"),
      { timeout: 2_000 },
    );
  });

  it("names several sticks plugged in together", () => {
    expect(
      pluggedInWords({
        ...offer,
        sticks: [...offer.sticks, { path: "/dev/ttyACM1", label: "ConBee" }],
      }),
    ).toBe("Zigbee sticks were plugged in");
  });
});
