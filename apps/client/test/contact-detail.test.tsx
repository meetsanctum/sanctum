// @vitest-environment jsdom
import { quietAfterMs, type DeviceInfo } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { contactNow, ContactPage } from "../src/contact-detail";
import { coreJson } from "../src/core-fetch";
import { tilesOf } from "../src/device-tiles";
import { contactSensor, places } from "./place-pages-fixtures";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

// A contact sensor's Contact page: what it says now, and its day and its
// week from core History.

const minute = 60_000;
// 15:00 where the tests run.
const now = new Date(2026, 9, 31, 15).getTime();
const at = (hours: number, minutes = 0) =>
  new Date(2026, 9, 31, hours, minutes).toISOString();

const contactOf = (device: DeviceInfo) =>
  device.capabilities.find((each) => each.kind === "contact")!;
const says = (device: DeviceInfo, when = now) =>
  contactNow(device, contactOf(device), when);

describe("what a contact sensor's detail says now", () => {
  it("is whether it is open, with since when it has been closed", () => {
    expect(says(contactSensor("door", "Door", "hall", false, at(13, 56)))).toBe(
      "Closed since 13:56",
    );
    expect(
      says(
        contactSensor(
          "door",
          "Door",
          "hall",
          true,
          new Date(now - 12 * minute).toISOString(),
        ),
      ),
    ).toBe("Open for 12 min");
    expect(says(contactSensor("door", "Door", "hall", null))).toBe(
      "Waiting for a reading",
    );
  });

  it.each([true, false])(
    "stops being an old reading when its battery goes quiet (open: %s)",
    (open) => {
      const device: DeviceInfo = {
        ...contactSensor("door", "Door", "hall", open),
        availability: "unknown",
        lastSeenAt: new Date(now - quietAfterMs).toISOString(),
      };
      expect(says(device, now - 1)).toBe(open ? "Open" : "Closed");
      expect(says(device)).toBe("Not heard from");
      expect(says({ ...device, lastSeenAt: new Date(now).toISOString() })).toBe(
        open ? "Open" : "Closed",
      );
    },
  );

  it.each([null, new Date(now - 60_000).toISOString()])(
    "is what its tile says when offline (left at: %s)",
    (leftAt) => {
      const device: DeviceInfo = {
        ...contactSensor("door", "Door", "hall", false),
        availability: "offline",
        leftAt,
      };
      const tile = tilesOf([device], places, new Map(), now)[0]!;
      expect(says(device)).toBe(tile.status);
    },
  );
});

describe("a contact sensor's page", () => {
  let root: Root;
  let container: HTMLDivElement;
  let kept: boolean;
  const door = contactSensor("door", "Front door", "hall", false, at(13, 56));
  // Its day: closed, open from 08:00 to 08:04 and from 13:52 to 13:56.
  const states = [
    { at: at(-9), availability: "online", state: { open: false } },
    { at: at(8), availability: "online", state: { open: true } },
    { at: at(8, 4), availability: "online", state: { open: false } },
    { at: at(13, 52), availability: "online", state: { open: true } },
    { at: at(13, 56), availability: "online", state: { open: false } },
  ];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    kept = true;
    vi.mocked(coreJson).mockReset();
    vi.mocked(coreJson).mockImplementation(async (path) => {
      const query = new URL(path, "http://core").searchParams;
      const common = {
        device: "door",
        capability: "contact",
        kind: "contact",
        from: query.get("from"),
        to: query.get("to"),
        kept,
      };
      if (path.startsWith("/api/history/states")) {
        return { ...common, states: kept ? states : [] };
      }
      if (path.startsWith("/api/history/statistics")) {
        // Yesterday, open for half of one hour.
        return {
          ...common,
          period: "hour",
          fields: {
            open: [
              {
                start: new Date(2026, 9, 30, 8).toISOString(),
                mean: 0.5,
                min: 0,
                max: 1,
                seconds: 3600,
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected ${path}`);
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function show(device = door) {
    await act(async () => {
      root.render(
        <ContactPage device={device} capability={contactOf(device)} />,
      );
    });
    // The history arrives.
    await act(async () => {});
  }

  it("has its day as a sentence and a band, and its week, in a contact sensor's words", async () => {
    await show();

    const text = container.textContent ?? "";
    expect(text).toContain("Last 24 hours");
    expect(text).toContain("Closed since 13:56");
    expect(text).toContain("Opened 2 times, 8 min in all, the last at 13:52");
    expect(
      container.querySelector(
        '[role="group"][aria-label="Open and closed over the last 24 hours"]',
      ),
    ).not.toBeNull();
    // A screen reader gets the spans as a list, in its words.
    expect(
      [...container.querySelectorAll("ul.sr-only li")].map(
        (each) => each.textContent,
      ),
    ).toEqual(
      expect.arrayContaining([
        "08:00 to 08:04: Open",
        "08:04 to 13:52: Closed",
        "13:52 to 13:56: Open",
      ]),
    );
    expect(text).toContain("Last 7 days");
    expect(text).toContain("Open about 30 min a day");
    expect(text).toContain("Battery 95%");
  });

  it("has a door's week as how often it was opened, from a week of its changes", async () => {
    await show({ ...door, type: "door", shownAs: "door" });

    // Include the state before the week's first midnight.
    const asked = vi
      .mocked(coreJson)
      .mock.calls.map(([path]) => path)
      .find((path) => path.startsWith("/api/history/states"))!;
    expect(new URL(asked, "http://core").searchParams.get("from")).toBe(
      new Date(new Date(2026, 9, 25).getTime() - 1).toISOString(),
    );

    const text = container.textContent ?? "";
    // The day stays as it is.
    expect(text).toContain("Opened 2 times, 8 min in all, the last at 13:52");
    // The week counts: twice today, of the two days the roll-ups know.
    expect(text).toContain("Opened 2 times since Fri");
    const columns = container.querySelector(
      '[role="group"][aria-label="How often it was opened each day"]',
    );
    expect(columns).not.toBeNull();
    expect(columns!.parentElement!.textContent).not.toContain(" h");
    expect(
      [...container.querySelectorAll("ul.sr-only li")]
        .map((each) => each.textContent)
        .filter((each) => /opened|Not opened/.test(each ?? ""))
        .at(-1),
    ).toMatch(/: opened 2 times$/);
  });

  it("keeps a contact sensor's and a window's week as how long it was open", async () => {
    await show({ ...door, type: "window", shownAs: "window" });
    const asked = vi
      .mocked(coreJson)
      .mock.calls.map(([path]) => path)
      .find((path) => path.startsWith("/api/history/states"))!;
    expect(new URL(asked, "http://core").searchParams.get("from")).toBe(
      new Date(now - 24 * 60 * 60_000).toISOString(),
    );
    expect(container.textContent).toContain("Open about 30 min a day");
    expect(
      container.querySelector(
        '[role="group"][aria-label="How long it was open each day"]',
      ),
    ).not.toBeNull();
  });

  it("keeps an opening at the week's first midnight through the history read and chart", async () => {
    const firstMidnight = new Date(2026, 9, 25).getTime();
    const changes = [
      { at: firstMidnight - minute, open: false },
      { at: firstMidnight, open: true },
      { at: firstMidnight + minute, open: false },
    ];
    vi.mocked(coreJson).mockImplementationOnce(async (path) => {
      const query = new URL(path, "http://core").searchParams;
      const from = Date.parse(query.get("from")!);
      // The core returns the last state at or before from, then later changes.
      const before = changes.filter((change) => change.at <= from).slice(-1);
      const during = changes.filter((change) => change.at > from);
      return {
        kind: "contact",
        kept: true,
        to: query.get("to"),
        states: [...before, ...during].map((change) => ({
          at: new Date(change.at).toISOString(),
          availability: "online",
          state: { open: change.open },
        })),
      };
    });
    await show({ ...door, type: "door", shownAs: "door" });

    const columns = container.querySelector<HTMLDivElement>(
      '[role="group"][aria-label="How often it was opened each day"]',
    )!;
    await act(async () => {
      columns.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      );
    });
    expect(columns.textContent).toContain("Opened once");
    expect(container.textContent).toMatch(/Sun 25 Oct: opened once/);
  });

  it("shows an opening at today's midnight before time has elapsed", async () => {
    const today = new Date(2026, 9, 31).getTime();
    vi.setSystemTime(today);
    vi.mocked(coreJson)
      .mockResolvedValueOnce({
        kind: "contact",
        kept: true,
        to: new Date(today).toISOString(),
        states: [
          {
            at: new Date(today - minute).toISOString(),
            availability: "online",
            state: { open: false },
          },
          {
            at: new Date(today).toISOString(),
            availability: "online",
            state: { open: true },
          },
        ],
      })
      .mockResolvedValueOnce({ fields: { open: [] } });
    await show({
      ...contactSensor("door", "Front door", "hall", true),
      type: "door",
      shownAs: "door",
    });

    const columns = container.querySelector<HTMLDivElement>(
      '[role="group"][aria-label="How often it was opened each day"]',
    )!;
    await act(async () => columns.focus());
    expect(columns.textContent).toContain("Opened once");
    expect(container.textContent).toContain("Opened once since Fri");
    expect(container.textContent).toMatch(/Sat 31 Oct: opened once/);
  });

  it("says at its foot that its battery is low where the sensor says so, without a charge", async () => {
    await show({ ...door, battery: null, batteryLow: true });
    expect(container.textContent).toContain("Battery low: replace it soon");

    await show({ ...door, battery: null });
    expect(container.textContent).not.toContain("Battery");
  });

  it("says so where the household does not keep its history", async () => {
    kept = false;
    await show();

    const text = container.textContent ?? "";
    expect(text).toContain("Closed since 13:56");
    expect(text).toContain("doesn't keep this device's history");
    expect(container.querySelector('[role="group"]')).toBeNull();
    expect(text).not.toContain("Last 7 days");
  });

  it("counts an opening as soon as the live reading arrives", async () => {
    await show();
    vi.setSystemTime(now + minute);
    await show(contactSensor("door", "Front door", "hall", true, at(15, 1)));

    expect(container.textContent).toContain(
      "Opened 3 times, 8 min in all, this time since 15:01",
    );
  });

  it("stops saying this time since as soon as the live reading closes", async () => {
    await show();
    vi.setSystemTime(now + minute);
    await show(contactSensor("door", "Front door", "hall", true, at(15, 1)));
    vi.setSystemTime(now + 3 * minute);
    await show(contactSensor("door", "Front door", "hall", false, at(15, 3)));

    expect(container.textContent).toContain(
      "Opened 3 times, 10 min in all, the last at 15:01",
    );
  });
});
