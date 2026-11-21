// @vitest-environment jsdom
import type { AppInfo, DeviceInfo, FirmwareInfo } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreError, coreJson } from "../src/core-fetch";
import { MaintenancePage } from "../src/settings-maintenance";

// Maintenance in Settings: what's due in Settings' section, and the page of
// every battery and update, whose rows keep their place until it closes.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const office = { id: "office", name: "Office", floorId: null };
const hall = { id: "hall", name: "Hall", floorId: null };
const rooms = [office, hall];
const zigbee: AppInfo = {
  id: "sanctum.zigbee",
  name: "Zigbee",
  version: "0.2.0",
  icon: { glyph: "radio-tower", color: "graphite" },
  pages: ["main"],
  permissions: ["devices.register"],
  requests: [],
  state: "running",
  settings: null,
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
};

function firmware(extra: Partial<FirmwareInfo> = {}): FirmwareInfo {
  return {
    version: "1.126.9",
    updatable: true,
    sleeps: false,
    state: "current",
    progress: null,
    remainingSeconds: null,
    problem: null,
    checkedAt: null,
    startedAt: null,
    endedAt: null,
    ...extra,
  };
}

function device(
  id: string,
  name: string,
  kind: "light" | "button" | "sensor",
  extra: Partial<DeviceInfo> = {},
): DeviceInfo {
  const capability =
    kind === "light"
      ? {
          id: "light",
          kind: "light" as const,
          features: { brightness: true, colorTemperature: null, color: false },
          state: { on: true },
          observed: { on: true },
          desired: null,
          sync: "synced" as const,
          setBy: null,
          changedAt: null,
        }
      : kind === "button"
        ? {
            id: "button",
            kind: "button" as const,
            features: { actions: ["single"], holds: [] },
            state: null,
            observed: null,
            desired: null,
            sync: "synced" as const,
            setBy: null,
            changedAt: null,
          }
        : {
            id: "temperature",
            kind: "sensor" as const,
            features: { measures: "temperature" as const },
            state: { value: 21 },
            observed: { value: 21 },
            desired: null,
            sync: "synced" as const,
            setBy: null,
            changedAt: null,
          };
  return {
    id,
    name,
    driver: "sanctum.zigbee",
    driverName:
      kind === "light"
        ? "Hue White ambiance"
        : kind === "button"
          ? "Wireless mini switch"
          : "Temperature and humidity sensor",
    type: kind,
    manufacturer: null,
    model: null,
    roomId: "office",
    availability: "online",
    lastSeenAt: "2026-10-31T11:00:00Z",
    capabilities: [capability],
    firmware:
      kind === "light"
        ? firmware()
        : firmware({ version: null, updatable: false, sleeps: true }),
    probe: kind === "light",
    identify: false,
    battery: kind === "light" ? null : 64,
    batteryLow: null,
    shownAs: null,
    leftAt: null,
    problem: null,
    ...extra,
  };
}

const quiet = device("button", "Office button", "button", {
  availability: "unknown",
  lastSeenAt: "2026-10-27T09:10:00Z",
  battery: 6,
});
const low = device("hall", "Hall sensor", "sensor", {
  roomId: "hall",
  battery: 8,
});
const kitchen = device("kitchen", "Kitchen button", "button");
const desk = device("desk", "Desk lamp", "light", {
  firmware: firmware({
    state: "updating",
    progress: 34,
    remainingSeconds: 3000,
  }),
});
const officeLight = device("office-light", "Office light", "light", {
  firmware: firmware({ state: "available" }),
});
const porch = device("porch", "Porch light", "light");

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
  vi.mocked(coreJson).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const rows = () =>
  [...container.querySelectorAll("li")].map((each) => each.textContent);

const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (each) => each.textContent === name,
  ) as HTMLButtonElement | undefined;

async function click(element: Element | undefined) {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

describe("the Maintenance page", () => {
  const onDone = vi.fn();
  const waiting = device("new", "Kitchen sensor", "sensor", {
    roomId: null,
    battery: null,
  });

  async function show(devices: DeviceInfo[]) {
    await act(async () =>
      root.render(
        <MaintenancePage
          devices={devices}
          rooms={rooms}
          apps={[zigbee]}
          onDone={onDone}
        />,
      ),
    );
  }

  it("keeps a row put right while it's shown, saying how", async () => {
    await show([low, quiet]);
    // The sensor has a new battery; the button is back in range.
    await show([
      { ...low, battery: 100 },
      {
        ...quiet,
        availability: "online",
        lastSeenAt: "2026-10-31T11:59:30Z",
        battery: 12,
      },
    ]);
    expect(container.textContent).toContain("Heard from just now");
    expect(container.textContent).toContain("New battery, up from 8%");
  });

  it("only calls a quiet device heard from after a report, and keeps the time fresh", async () => {
    const silent = { ...quiet, battery: 64 };
    await show([silent]);
    await show([{ ...silent, availability: "offline" }]);
    expect(container.textContent).not.toContain("Heard from");
    await show([
      {
        ...silent,
        availability: "online",
        lastSeenAt: "2026-10-31T12:00:00Z",
      },
    ]);
    expect(container.textContent).toContain("Heard from just now");
    await act(async () => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(container.textContent).toContain("Heard from 2 minutes ago");
  });

  it("lists every battery, the next to replace first, with its charge at the end", async () => {
    await show([kitchen, waiting, low, quiet, porch]);

    const [batteries] = container.querySelectorAll("section");
    expect(batteries?.textContent).toContain("4 devices · lowest first");
    expect(
      [...batteries!.querySelectorAll("li")].map((each) => each.textContent),
    ).toEqual([
      "Office buttonNot heard from since Tuesday: try a new battery · Office · Wireless mini switch6%",
      "Hall sensorBattery low: replace it soon · Hall · Temperature and humidity sensor8%",
      "Kitchen buttonOffice · Wireless mini switch64%",
      "Kitchen sensorSays its charge with its next reading · No room · Temperature and humidity sensor–",
    ]);
  });

  it("lists a battery its device says is low among the low ones, and says once it no longer is", async () => {
    const flagged = { ...kitchen, battery: 63, batteryLow: true };
    const unfigured = device("shed", "Shed door", "button", {
      battery: null,
      batteryLow: true,
    });
    const other = { ...kitchen, id: "other", name: "Hall button" };
    await show([other, unfigured, flagged, low]);

    const [batteries] = container.querySelectorAll("section");
    expect(
      [...batteries!.querySelectorAll("li")].map((each) => each.textContent),
    ).toEqual([
      "Hall sensorBattery low: replace it soon · Hall · Temperature and humidity sensor8%",
      "Kitchen buttonBattery low: replace it soon · Office · Wireless mini switch63%",
      "Shed doorBattery low: replace it soon · Office · Wireless mini switchLow",
      "Hall buttonOffice · Wireless mini switch64%",
    ]);

    await show([{ ...unfigured, batteryLow: false }, flagged, low]);
    expect(rows()).toContain(
      "Shed doorBattery no longer low · Office · Wireless mini switch–",
    );
  });

  it("says a battery is no longer low for a word of it that came after the row was first shown", async () => {
    // Low by its charge first; the device says so itself only later.
    await show([{ ...kitchen, battery: 8, batteryLow: false }]);
    await show([{ ...kitchen, battery: 15, batteryLow: true }]);
    expect(rows()[0]).toContain("Battery low: replace it soon");

    await show([{ ...kitchen, battery: 15, batteryLow: false }]);
    expect(rows()[0]).toContain("Battery no longer low");
  });

  it("lists a device that says only whether its battery is low, while it isn't", async () => {
    await show([{ ...kitchen, battery: null, batteryLow: false }, low]);
    expect(rows()).toContain(
      "Kitchen buttonBattery not low · Office · Wireless mini switch–",
    );
  });

  it("lists every update with its button, and says when there's none", async () => {
    await show([desk, officeLight, porch, kitchen]);

    const updates = container.querySelectorAll("section")[1]!;
    expect(updates.textContent).toContain("2 updates · 1 device up to date");
    expect(
      [...updates.querySelectorAll("li")].map((each) => each.textContent),
    ).toEqual([
      "Desk lampUpdating · 34% · about 50 minutes left · Office · Hue White ambiance",
      "Office lightUpdate available once Desk lamp has finished · Office · Hue White ambianceUpdate",
    ]);
    expect(button("Update")?.disabled).toBe(true);

    await show([porch]);
    expect(container.querySelectorAll("section")[1]?.textContent).toContain(
      "Everything's up to date",
    );
  });

  it("keeps an update's row once a check finds none, saying so", async () => {
    await show([officeLight, porch]);
    await show([
      {
        ...officeLight,
        firmware: firmware({ checkedAt: "2026-10-31T11:59:30Z" }),
      },
      porch,
    ]);
    expect(
      [...container.querySelectorAll("section")[1]!.querySelectorAll("li")].map(
        (each) => each.textContent,
      ),
    ).toEqual([
      "Office lightUp to date, checked just now · Office · Hue White ambiance",
    ]);
    expect(container.querySelectorAll("section")[1]?.textContent).not.toContain(
      "1 update",
    );
  });

  it("tracks a battery that falls low and is replaced while the page stays open", async () => {
    await show([kitchen]);
    await show([{ ...kitchen, battery: 8 }]);
    await show([{ ...kitchen, battery: 100 }]);
    expect(rows()[0]).toContain("New battery, up from 8%");

    await show([{ ...kitchen, battery: 5 }]);
    await show([{ ...kitchen, battery: 90 }]);
    expect(rows()[0]).toContain("New battery, up from 5%");
  });

  it("does not claim unknown firmware is up to date", async () => {
    await show([{ ...porch, firmware: firmware({ state: null }) }]);
    expect(container.textContent).not.toContain("Everything's up to date");
    expect(container.textContent).toContain("Not checked yet");
  });

  it("only dates the current devices when all of them have been checked", async () => {
    await show([
      {
        ...officeLight,
        firmware: firmware({ checkedAt: "2026-10-31T11:59:30Z" }),
      },
      porch,
    ]);
    expect(container.querySelectorAll("section")[1]?.textContent).not.toContain(
      "checked just now",
    );
    await show([
      {
        ...officeLight,
        firmware: firmware({ checkedAt: "2026-10-31T11:59:30Z" }),
      },
      { ...porch, firmware: firmware({ checkedAt: "2026-10-31T10:00:00Z" }) },
    ]);
    expect(container.querySelectorAll("section")[1]?.textContent).toContain(
      "2 devices up to date, checked 2 hours ago",
    );
  });

  it("asks before an update starts, and starts it", async () => {
    vi.mocked(coreJson).mockResolvedValue(officeLight);
    await show([officeLight, porch]);

    await click(button("Update"));
    expect(document.body.textContent).toContain("Update Office light?");
    await click(
      [...document.querySelectorAll("[role=dialog] button")].find(
        (each) => each.textContent === "Update",
      ),
    );
    expect(coreJson).toHaveBeenCalledWith("/api/devices/firmware/update", {
      method: "POST",
      json: { id: "office-light" },
    });
  });

  it("checks every device it can ask for updates, one after another, and says what it couldn't", async () => {
    vi.mocked(coreJson).mockImplementation(async (_path, init = {}) => {
      if ((init.json as { id: string }).id === "porch") {
        throw new CoreError(504, "timeout");
      }
      return officeLight;
    });
    await show([officeLight, porch, kitchen]);

    await click(button("Check for updates"));
    expect(
      vi.mocked(coreJson).mock.calls.map(([, init]) => init?.json),
    ).toEqual([{ id: "office-light" }, { id: "porch" }]);
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "Porch light: Couldn't check for an update: it didn't answer. Check it's switched on.",
    );
  });

  it("says there are no devices on batteries yet, and leaves Done to close it", async () => {
    onDone.mockReset();
    await show([porch]);
    expect(container.querySelector("section")?.textContent).toContain(
      "No devices on batteries yet",
    );
    await click(button("Done"));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("shows every failed check under the list", async () => {
    vi.mocked(coreJson).mockRejectedValue(new CoreError(504, "timeout"));
    await show([officeLight, porch]);
    await click(button("Check for updates"));
    const failures = container.querySelector("[role=alert]")?.textContent;
    expect(failures).toContain("Office light:");
    expect(failures).toContain("Porch light:");
  });
});
