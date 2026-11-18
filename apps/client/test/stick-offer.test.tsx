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

import { CoreError, coreJson } from "../src/core-fetch";
import { StickOffer } from "../src/stick-offer";

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
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const show = (isOnline = true) =>
  act(async () =>
    root.render(
      <StickOffer live={live} isOnline={isOnline} onAdded={() => undefined} />,
    ),
  );

// The calls the client made to one path, in order.
const callsTo = (path: string) =>
  vi.mocked(coreJson).mock.calls.filter(([called]) => called === path);

const dialog = () => document.body.querySelector('[role="dialog"]');
const button = (name: string) =>
  [...document.body.querySelectorAll("button")].find(
    ({ textContent }) => textContent === name,
  );
const later = (ms: number) =>
  act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((answer, fail) => {
    resolve = answer;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("a stick plugged in", () => {
  it("opens its app's add sheet, saying what happened", async () => {
    await show();

    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain("A Zigbee stick was plugged in");
    expect(dialog()!.textContent).toContain("Add Example?");
  });

  it("says no for every client on Cancel", async () => {
    await show();
    expect(dialog()).not.toBeNull();

    await act(async () => button("Cancel")!.click());

    expect(coreJson).toHaveBeenCalledWith("/api/hardware/offer/dismiss", {
      method: "POST",
      json: { id: "offer-1" },
    });
    expect(dialog()).toBeNull();
  });

  it("keeps the sheet open if Cancel could not be saved", async () => {
    await show();
    vi.mocked(coreJson).mockRejectedValueOnce(new Error("Disconnected"));

    await act(async () => button("Cancel")!.click());
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "That did not work. Try again.",
    );

    await act(async () => button("Cancel")!.click());
    expect(dialog()).toBeNull();
    // Each Cancel says no to the core, the second too.
    const no = {
      method: "POST",
      json: { id: "offer-1" },
    };
    expect(callsTo("/api/hardware/offer/dismiss")).toEqual([
      ["/api/hardware/offer/dismiss", no],
      ["/api/hardware/offer/dismiss", no],
    ]);
  });

  it("names the offer when adding its app", async () => {
    await show();
    expect(callsTo("/api/apps/add")).toEqual([]);

    await act(async () => button("Add Example")!.click());

    expect(callsTo("/api/apps/add")).toEqual([
      [
        "/api/apps/add",
        {
          method: "POST",
          json: { id: "sanctum.example", version: "1.0.0", offerId: "offer-1" },
        },
      ],
    ]);
  });

  it("stays until its Add answers, though the offer ends meanwhile", async () => {
    const adding = deferred<never>();
    await show();
    vi.mocked(coreJson).mockReturnValueOnce(adding.promise);
    await act(async () => button("Add Example")!.click());

    await hear({ type: "offer", offer: null });
    expect(dialog()).not.toBeNull();

    await act(async () => adding.reject(new CoreError(500, "app_failed")));
    expect(dialog()?.querySelector('[role="alert"]')).not.toBeNull();
    // It stays, with what went wrong, until someone closes it.
    await later(1_000);
    expect(dialog()?.querySelector('[role="alert"]')).not.toBeNull();

    await act(async () => button("Cancel")!.click());
    expect(dialog()).toBeNull();
  });

  it("closes once it ends on another client or is unplugged", async () => {
    await show();
    expect(dialog()).not.toBeNull();

    await hear({ type: "offer", offer: null });

    expect(dialog()).toBeNull();
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
    await later(1_000);
    expect(document.body.textContent).not.toContain("Add Example?");

    other.remove();

    await later(1_000);
    expect(document.body.textContent).toContain("Add Example?");
  });

  it("does not reopen an offer ended while the first read was in flight", async () => {
    const first = deferred<{ offer: HardwareOffer }>();
    vi.mocked(coreJson).mockReturnValueOnce(first.promise);
    await show();

    await hear({ type: "offer", offer: null });
    await act(async () => first.resolve({ offer }));

    expect(dialog()).toBeNull();
    expect(coreJson).not.toHaveBeenCalledWith("/api/apps/available");
  });

  it("hides the sheet while offline and reads the current offer when back", async () => {
    await show();
    expect(dialog()).not.toBeNull();

    await show(false);
    expect(dialog()).toBeNull();

    const reads = callsTo("/api/hardware/offer").length;
    vi.mocked(coreJson).mockResolvedValueOnce({ offer: null });
    await show();
    expect(callsTo("/api/hardware/offer")).toHaveLength(reads + 1);
    expect(dialog()).toBeNull();
  });

  it("retries the catalog when the first read fails", async () => {
    vi.mocked(coreJson).mockResolvedValueOnce({ offer });
    vi.mocked(coreJson).mockRejectedValueOnce(new Error("Disconnected"));
    await show();
    expect(dialog()).toBeNull();

    await later(1_000);
    expect(dialog()).not.toBeNull();
  });

  it("waits if another sheet opens while the catalog is being read", async () => {
    const list = deferred<AvailableApp[]>();
    vi.mocked(coreJson).mockResolvedValueOnce({ offer });
    vi.mocked(coreJson).mockReturnValueOnce(list.promise);
    await show();
    const other = document.createElement("div");
    other.setAttribute("role", "dialog");
    document.body.append(other);

    await act(async () => list.resolve([zigbee]));
    expect(document.body.textContent).not.toContain("Add Example?");

    other.remove();
    await later(1_000);
    expect(document.body.textContent).toContain("Add Example?");
  });

  it("names several sticks plugged in together", async () => {
    await show();
    await hear({
      type: "offer",
      offer: {
        ...offer,
        sticks: [...offer.sticks, { path: "/dev/ttyACM1", label: "ConBee" }],
      },
    });

    expect(dialog()?.textContent).toContain("Zigbee sticks were plugged in");
  });
});
