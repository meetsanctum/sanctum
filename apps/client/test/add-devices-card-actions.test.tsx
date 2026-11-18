// @vitest-environment jsdom
import type { DeviceInfo, PairingInfo, Room } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AddDevices } from "../src/add-devices";
import { CoreError, coreJson } from "../src/core-fetch";
import { light, office, zigbee } from "./settings-devices-fixtures";

vi.mock("../src/core-fetch", async (original) => ({
  ...(await original<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

describe("actions on a device's Add devices card", () => {
  let root: Root;
  let container: HTMLDivElement;
  let rooms: Room[];
  const live = createLiveFeed();
  const device = light("odd", "Unknown Device", { capabilities: [] });
  const hall = { ...office, id: "hall", name: "Hall" };
  const removed = vi.fn();
  const closed = vi.fn();
  const changed = vi.fn();
  const pairing: PairingInfo = {
    until: "2026-10-29T12:04:00.000Z",
    drivers: [zigbee.id],
    finders: [],
    offers: [],
    found: [],
    joined: [
      {
        driver: zigbee.id,
        key: "0x9",
        stage: "ready",
        description: null,
        deviceId: device.id,
        known: false,
        joinedAt: "2026-10-29T12:00:00.000Z",
      },
    ],
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
    rooms = [office];
    removed.mockReset();
    closed.mockReset();
    changed.mockReset();
    vi.mocked(coreJson).mockReset();
    vi.mocked(coreJson).mockImplementation(async (path) => {
      switch (path) {
        case "/api/devices/pairing/open":
          return { ...pairing, since: "2026-10-29T12:00:00.000Z" };
        case "/api/devices/pairing/close":
          return { ...pairing, until: null };
        case "/api/places/rooms/add":
          return hall;
        case "/api/devices/update":
          return { ...device, roomId: hall.id };
        default:
          throw new Error(`Unexpected request: ${path}`);
      }
    });
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

  async function show() {
    await act(async () =>
      root.render(
        <AddDevices
          open
          onOpenChange={closed}
          devices={[device]}
          rooms={rooms}
          apps={[zigbee]}
          adding={pairing}
          live={live}
          onChanged={changed}
          onRemoved={removed}
        />,
      ),
    );
  }

  async function click(text: string) {
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === text)!
        .click(),
    );
  }

  async function join() {
    await show();
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.startsWith("Zigbee"))!
        .click(),
    );
  }

  const asking = () =>
    [...document.querySelectorAll<HTMLElement>("[role=dialog]")].at(-1)!;
  const submit = () =>
    asking().querySelector<HTMLButtonElement>("button[type=submit]")!;

  it("keeps removal pending through countdown updates, then closes its confirmation", async () => {
    let finish!: () => void;
    const answer = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation((path, init) =>
      path === "/api/devices/remove"
        ? new Promise((resolve) => (finish = () => resolve(undefined)))
        : answer(path, init),
    );
    await join();
    await click("Remove");
    await act(async () => submit().click());
    expect(submit().disabled).toBe(true);

    await act(async () => vi.advanceTimersByTime(1_000));
    expect(submit().disabled).toBe(true);
    await act(async () => finish());

    expect(removed).toHaveBeenCalledWith(device.id);
    expect(document.querySelectorAll("[role=dialog]")).toHaveLength(1);
    expect(
      document.querySelector('button[aria-label="Remove Unknown Device"]'),
    ).toBeNull();
  });

  it("keeps the offer to remove anyway through countdown updates", async () => {
    const answer = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation(async (path, init) => {
      if (path !== "/api/devices/remove") return answer(path, init);
      if (!(init?.json as { force: boolean }).force)
        throw new CoreError(504, "timeout");
    });
    await join();
    await click("Remove");
    await act(async () => submit().click());
    expect(submit().textContent).toBe("Remove anyway");

    await act(async () => vi.advanceTimersByTime(1_000));
    expect(submit().textContent).toBe("Remove anyway");
    await act(async () => submit().click());

    expect(coreJson).toHaveBeenLastCalledWith("/api/devices/remove", {
      method: "POST",
      json: { id: device.id, force: true },
    });
    expect(removed).toHaveBeenCalledWith(device.id);
  });

  async function roomMenu() {
    await act(async () =>
      document
        .querySelector('button[aria-label="Unknown Device: room"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        ),
    );
  }

  it("discards a save that finishes after the device is removed", async () => {
    let finish!: (device: DeviceInfo) => void;
    const answer = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation((path, init) => {
      if (path === "/api/devices/update")
        return new Promise((resolve) => (finish = resolve as typeof finish));
      if (path === "/api/devices/remove") return Promise.resolve(undefined);
      return answer(path, init);
    });
    await join();
    await roomMenu();
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>("[role=menuitemradio]")]
        .find((item) => item.textContent === "Office")!
        .click(),
    );
    await click("Remove");
    await act(async () => submit().click());
    expect(removed).toHaveBeenCalledWith(device.id);

    await act(async () => finish({ ...device, roomId: office.id }));

    expect(changed).not.toHaveBeenCalled();
  });

  async function newRoom() {
    await roomMenu();
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>("[role=menuitem]")]
        .find((item) => item.textContent === "New room…")!
        .click(),
    );
    return document.querySelector<HTMLInputElement>("form input")!;
  }

  it("leaves room naming on Escape without closing Add devices", async () => {
    await join();
    const field = await newRoom();
    await act(async () =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );

    expect(closed).not.toHaveBeenCalled();
    expect(document.querySelector("form input")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Unknown Device: room",
    );
  });

  async function typeName(field: HTMLInputElement, name: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, name);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  const calls = (path: string) =>
    vi.mocked(coreJson).mock.calls.filter(([called]) => called === path);

  it("keeps naming open when the move fails, and moves into the made room on retry", async () => {
    const answer = vi.mocked(coreJson).getMockImplementation()!;
    let failing = true;
    vi.mocked(coreJson).mockImplementation(async (path, init) => {
      if (path === "/api/devices/update" && failing) {
        failing = false;
        throw new CoreError(504, "timeout");
      }
      return answer(path, init);
    });
    await join();
    await typeName(await newRoom(), hall.name);
    await click("Add room");
    expect(document.querySelector("form input")).not.toBeNull();

    await click("Add room");

    expect(document.querySelector("form input")).toBeNull();
    expect(calls("/api/places/rooms/add")).toHaveLength(1);
    expect(calls("/api/devices/update").at(-1)![1]).toEqual({
      method: "POST",
      json: { id: device.id, roomId: hall.id },
    });
  });

  it("moves nothing once naming is left while the room is being made", async () => {
    let finish!: (room: Room) => void;
    const den = { ...office, id: "den", name: "Den" };
    const answer = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation((path, init) => {
      if (path !== "/api/places/rooms/add") return answer(path, init);
      if (calls(path).length > 1) return Promise.resolve(den);
      return new Promise((resolve) => (finish = resolve as typeof finish));
    });
    await join();
    const field = await newRoom();
    await typeName(field, hall.name);
    await click("Add room");
    await act(async () =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await act(async () => finish(hall));
    expect(calls("/api/devices/update")).toHaveLength(0);

    // The room made after Escape isn't the one the next naming uses.
    await typeName(await newRoom(), den.name);
    await click("Add room");
    expect(calls("/api/places/rooms/add")).toHaveLength(2);
    expect(calls("/api/devices/update").at(-1)![1]).toEqual({
      method: "POST",
      json: { id: device.id, roomId: den.id },
    });
  });

  it("leaves room naming with Cancel, making no room", async () => {
    await join();
    await typeName(await newRoom(), hall.name);
    await click("Cancel");

    expect(document.querySelector("form input")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Unknown Device: room",
    );
    expect(calls("/api/places/rooms/add")).toHaveLength(0);
  });

  it("drops a created room after the home confirms and removes it", async () => {
    await join();
    await newRoom();
    const field = document.querySelector<HTMLInputElement>("form input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, hall.name);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Add room");
    // The response supplies the room until the home's live list includes it.
    rooms = [office, hall];
    await show();
    rooms = [office];
    await show();
    await roomMenu();

    expect(
      [...document.querySelectorAll("[role=menuitemradio]")].map(
        (item) => item.textContent,
      ),
    ).toEqual(["Office", "No room"]);
  });
});
