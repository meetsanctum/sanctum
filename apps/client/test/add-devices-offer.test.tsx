// @vitest-environment jsdom
import type {
  AvailableApp,
  DeviceOffer,
  PairingInfo,
} from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AddDevices } from "../src/add-devices";
import { coreJson } from "../src/core-fetch";
import { office, zigbee } from "./settings-devices-fixtures";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

// An app the home could add for devices found on its network is offered in
// Add devices: its card says how many, and pressing it opens its add sheet.

const offer: DeviceOffer = {
  app: "sanctum.example",
  name: "Example",
  found: 2,
};
const example: AvailableApp = {
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
const added = { ...zigbee, id: "sanctum.example", name: "Example" };

let root: Root;
let container: HTMLDivElement;
let adding: PairingInfo;
let available: AvailableApp[];
const live = createLiveFeed();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  adding = {
    until: null,
    joined: [],
    drivers: ["sanctum.zigbee"],
    finders: [],
    found: [],
    offers: [offer],
  };
  available = [example];
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    switch (path) {
      case "/api/apps/available":
        return available;
      case "/api/apps/add":
        return added;
      default:
        return {};
    }
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const show = () =>
  act(async () =>
    root.render(
      <AddDevices
        open
        onOpenChange={() => undefined}
        devices={[]}
        rooms={[office]}
        apps={[zigbee]}
        adding={adding}
        live={live}
        onChanged={() => undefined}
      />,
    ),
  );

const cards = () =>
  [
    ...document.querySelectorAll(
      "[role=dialog] [data-slot=overlay-content] li",
    ),
  ].map((card) => card.textContent);
const press = (name: string) => act(async () => button(name).click());
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((each) =>
    each.textContent?.startsWith(name),
  )!;
// The add sheet, over the overlay.
const sheet = () =>
  [...document.querySelectorAll("[role=dialog]")].find((each) =>
    each.textContent?.includes("Add Example?"),
  );

describe("an app offered for devices found", () => {
  it("says how many were found, beside each radio", async () => {
    await show();

    expect(cards()).toEqual([
      "ZigbeeLights, sensors and remotesStart",
      "Example2 Example devices foundAdd Example",
    ]);
  });

  it("names one device found", async () => {
    adding = { ...adding, offers: [{ ...offer, found: 1 }] };
    await show();
    await press("Example");

    expect(cards()).toContain("Example1 Example device foundAdd Example");
    expect(sheet()?.textContent).toContain("An Example device was found");
  });

  it("opens its add sheet, saying what was found", async () => {
    await show();
    expect(sheet()).toBeUndefined();

    await press("Example");

    expect(sheet()?.textContent).toContain("2 Example devices were found");
  });

  it("goes to Devices found once it's added", async () => {
    await show();
    await press("Example");

    await act(async () =>
      [...sheet()!.querySelectorAll("button")]
        .find((each) => each.textContent === "Add")!
        .click(),
    );

    expect(coreJson).toHaveBeenCalledWith("/api/apps/add", {
      method: "POST",
      json: { id: "sanctum.example", version: "1.0.0", offerId: undefined },
    });
    expect(sheet()).toBeUndefined();
    expect(
      document.querySelector("[role=dialog] h2, [role=dialog] h1")?.textContent,
    ).toBe("Devices found");
  });

  it("stays on the first page on Cancel", async () => {
    await show();
    const opener = button("Example");
    await act(async () => opener.focus());
    await press("Example");

    await press("Cancel");

    expect(sheet()).toBeUndefined();
    expect(cards()).toHaveLength(2);
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("drops a pending sheet when another way is chosen", async () => {
    adding = { ...adding, finders: ["sanctum.zigbee"] };
    let finishListing!: (apps: AvailableApp[]) => void;
    const listing = new Promise<AvailableApp[]>((resolve) => {
      finishListing = resolve;
    });
    vi.mocked(coreJson).mockReturnValueOnce(listing);
    await show();
    await press("Example");

    await press("Devices found");
    await act(async () => finishListing([example]));

    expect(sheet()).toBeUndefined();
    await press("Add devices");
    expect(sheet()).toBeUndefined();
  });

  it("returns focus to Add devices if the offer disappeared", async () => {
    await show();
    const overlay = document.querySelector('[role="dialog"]');
    await press("Example");
    await act(async () =>
      live.publish({ type: "pairing", pairing: { ...adding, offers: [] } }),
    );

    await press("Cancel");

    await vi.waitFor(() => expect(document.activeElement).toBe(overlay));
  });

  it("opens nothing once it was added elsewhere", async () => {
    available = [];
    await show();

    await press("Example");

    expect(sheet()).toBeUndefined();
  });

  it("says so when its sheet couldn't be read", async () => {
    await show();
    vi.mocked(coreJson).mockRejectedValueOnce(new Error("Disconnected"));

    await press("Example");

    expect(sheet()).toBeUndefined();
    expect(document.querySelector("[role=alert]")?.textContent).toBe(
      "That did not work. Try again.",
    );
  });

  it("follows the offers live", async () => {
    await show();

    await act(async () =>
      live.publish({ type: "pairing", pairing: { ...adding, offers: [] } }),
    );

    expect(cards()).toEqual(["ZigbeeLights, sensors and remotesStart"]);
  });
});
