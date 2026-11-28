// @vitest-environment jsdom
import type { DeviceInfo } from "@meetsanctum/app-sdk";
import type { Me } from "@meetsanctum/auth-protocol";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { CoreError, coreJson } from "../src/core-fetch";
import { pressShownMs } from "../src/device-line";
import {
  light,
  macbook,
  office,
  places,
  remote,
} from "./settings-devices-fixtures";
import {
  admin,
  button,
  choose,
  container,
  devices,
  home,
  homeChanges,
  live,
  onRemove,
  requests,
  setDevices,
  show,
  type,
} from "./settings-devices-harness";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

function pendingReply<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("Settings → Devices", () => {
  it("is for every client, shared ones too", async () => {
    await show(admin, null);
    expect(container.textContent).toContain("Devices");
    expect(container.textContent).toContain("Add devices");

    await show(
      {
        client: { ...macbook, kind: "shared", personId: null },
        person: null,
      } as unknown as Me,
      null,
    );
    expect(container.textContent).toContain("Add devices");
  });

  it("lists the devices and follows them live", async () => {
    await show(admin);
    expect(container.textContent).toContain("Light");
    expect(container.textContent).toContain(
      "No room · Hue Essential White and Color Ambiance A60",
    );

    await act(async () =>
      live.publish({
        type: "device",
        id: "desk",
        device: light("desk", "Office light", { roomId: "office" }),
      }),
    );
    expect(container.textContent).toContain("Office light");

    // The category's page stays once its last device goes, and says so.
    await act(async () =>
      live.publish({ type: "device", id: "desk", device: null }),
    );
    expect(container.querySelector("h1")?.textContent).toBe("Lights");
    expect(container.textContent).toContain("No lights any more");
    expect(container.textContent).toContain("Lights you add show here");
  });

  it("lists a device with a part of a kind this build does not know", async () => {
    // As a core newer than this build might serve it.
    const valve = { ...light("x", "x").capabilities[0]!, kind: "valve" };
    const withValve = (device: DeviceInfo, own = device.capabilities) =>
      ({ ...device, capabilities: [...own, valve] }) as unknown as DeviceInfo;
    setDevices([
      withValve(light("desk", "Light")),
      withValve(light("tap", "Garden tap"), []),
    ]);
    await show(admin);
    expect(container.textContent).toContain("Light");
    expect(container.textContent).toContain("Garden tap");

    await act(async () =>
      live.publish({
        type: "device",
        id: "drain",
        device: withValve(light("drain", "Drain"), []),
      }),
    );
    expect(container.textContent).toContain("Drain");

    // The device a change answers with is taken the same way.
    await choose("Garden tap: more", "Rename");
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    await type(dialog.querySelector("input")!, "Hose");
    await act(async () => button("Save").click());
    expect(container.textContent).toContain("Hose");
  });

  it.each([false, true])(
    "leaves history out when it knows none of a device's parts (live: %s)",
    async (isLive) => {
      const known = light("tap", "Garden tap");
      const unknown = {
        ...known,
        capabilities: [{ ...known.capabilities[0]!, kind: "valve" }],
      } as unknown as DeviceInfo;
      setDevices([isLive ? known : unknown]);
      await show(admin);
      if (isLive) {
        await act(async () =>
          live.publish({ type: "device", id: unknown.id, device: unknown }),
        );
      }

      const trigger = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Garden tap: more"]',
      )!;
      await act(async () =>
        trigger.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        ),
      );
      expect(
        [...document.querySelectorAll("[role=menuitemcheckbox]")].some(
          (item) => item.textContent === "Keep history",
        ),
      ).toBe(false);
    },
  );

  it("shows a remote's presses as they happen, for a few seconds", async () => {
    vi.useFakeTimers({
      toFake: [
        "Date",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    setDevices([light("desk", "Light"), remote]);
    await show(admin, "buttons");
    const press = (action: string) =>
      act(async () =>
        live.publish({
          type: "press",
          device: "remote",
          capability: "button",
          action,
          at: "2026-10-29T12:00:00.000Z",
          isCaptured: false,
        }),
      );
    expect(container.textContent).toContain("Office · Wireless mini switch");
    expect(container.textContent).not.toContain("just now");

    await press("single");
    expect(container.textContent).toContain(
      "Office · Wireless mini switch · Single press just now",
    );
    await act(async () => vi.advanceTimersByTime(pressShownMs - 1_000));
    await press("double");
    await act(async () => vi.advanceTimersByTime(pressShownMs - 1_000));
    expect(container.textContent).toContain("Double press just now");

    await act(async () => vi.advanceTimersByTime(1_000));
    expect(container.textContent).not.toContain("just now");
  });

  it("keeps what changed live while the list was being read", async () => {
    let answer!: (value: DeviceInfo[]) => void;
    const original = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation(async (path, init) =>
      path === "/api/devices"
        ? new Promise((resolve) => (answer = resolve as typeof answer))
        : original(path, init),
    );
    await show(admin);

    await act(async () => {
      live.publish({
        type: "device",
        id: "desk",
        device: light("desk", "Office light", { roomId: "office" }),
      });
      live.publish({
        type: "places",
        places: { ...places, rooms: [{ ...office, name: "Study" }] },
      });
    });
    // The answer was read before both changes.
    await act(async () =>
      answer([light("desk", "Light"), light("lamp", "Light 2")]),
    );

    expect(container.textContent).toContain("Office light");
    expect(container.textContent).toContain("Study · Hue");
    expect(container.textContent).toContain("Light 2");
    expect(container.textContent).not.toMatch(/Light(?! 2)No room/);
  });

  it("renames a device, and an empty name names it after its room", async () => {
    await show(admin);
    await choose("Light: more", "Rename");
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;

    await type(dialog.querySelector("input")!, "  ");
    await act(async () => button("Save").click());

    expect(requests).toContainEqual({
      path: "/api/devices/update",
      json: { id: "desk", name: null },
    });
  });

  it("shows a device on Home from its menu, or no longer", async () => {
    await show(admin);
    const item = async () => {
      await act(async () =>
        document
          .querySelector('button[aria-label="Light: more"]')!
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          ),
      );
      return [
        ...document.querySelectorAll<HTMLElement>("[role=menuitemcheckbox]"),
      ].find((candidate) => candidate.textContent === "Show on Home")!;
    };

    expect((await item()).getAttribute("aria-checked")).toBe("true");
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await choose("Light: more", "Show on Home");
    expect(homeChanges).toEqual(["remove desk"]);

    home.devices = [];
    await show(admin);
    await choose("Light: more", "Show on Home");
    expect(homeChanges).toEqual(["remove desk", "add desk"]);
  });

  it("stops keeping a device's history once asked, which deletes it, and keeps it again", async () => {
    await show(admin);
    await choose("Light: more", "Keep history");
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.textContent).toContain("Stop keeping Light's history?");
    expect(dialog.textContent).toContain(
      "Sanctum deletes what it has kept of it",
    );
    await act(async () => button("Delete history").click());
    expect(requests).toContainEqual({
      path: "/api/history/keep",
      json: { device: "desk", kept: false },
    });

    await choose("Light: more", "Keep history");
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(requests.at(-1)).toEqual({
      path: "/api/history/keep",
      json: { device: "desk", kept: true },
    });
  });

  it("offers history settings for a device added while Settings is open", async () => {
    await show(admin);
    const added = light("bulb", "Light 2");
    setDevices([...devices, added]);
    await act(async () => {
      live.publish({ type: "device", id: added.id, device: added });
    });
    await choose("Light 2: more", "Keep history");
    expect(document.querySelector("[role=dialog]")?.textContent).toContain(
      "Stop keeping Light 2's history?",
    );
  });

  it("keeps a history choice made while the list was being read", async () => {
    await show(admin);
    let answer!: (value: unknown) => void;
    const original = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation(async (path, init) =>
      path === "/api/history/devices"
        ? new Promise((resolve) => (answer = resolve))
        : original(path, init),
    );
    await act(async () => live.refresh());

    await choose("Light: more", "Keep history");
    await act(async () => button("Delete history").click());
    // The answer was read before the choice.
    await act(async () => answer([{ device: "desk", kept: true }]));

    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Light: more"]',
    )!;
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(
      [...document.querySelectorAll("[role=menuitemcheckbox]")]
        .find((item) => item.textContent === "Keep history")
        ?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("removes a device, and by force once its driver could not", async () => {
    await show(admin);
    onRemove(({ force }) => {
      if (!force) throw new CoreError(500, "app_failed");
    });
    await choose("Light: more", "Remove");
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.textContent).toContain(
      "It leaves the Zigbee network and Sanctum forgets it",
    );

    await act(async () => button("Remove").click());
    expect(dialog.textContent).toContain("Light did not answer");
    await act(async () => button("Remove anyway").click());

    expect(
      requests.filter((each) => each.path === "/api/devices/remove"),
    ).toEqual([
      { path: "/api/devices/remove", json: { id: "desk", force: false } },
      { path: "/api/devices/remove", json: { id: "desk", force: true } },
    ]);
    expect(container.textContent).toContain("No lights any more");
  });

  it.each([
    ["Rename", "Save", "/api/devices/update", "Light wasn't renamed"],
    [
      "Keep history",
      "Delete history",
      "/api/history/keep",
      "Light's history wasn't deleted",
    ],
    ["Remove", "Remove", "/api/devices/remove", "Light wasn't removed"],
  ])(
    "says what failed when submitting %s",
    async (choice, submit, path, title) => {
      await show(admin);
      await choose("Light: more", choice);
      vi.mocked(coreJson).mockRejectedValueOnce(
        new CoreError(404, "not_found"),
      );

      await act(async () => button(submit).click());

      expect(coreJson).toHaveBeenLastCalledWith(path, expect.anything());
      const dialog = document.querySelector("[role=dialog]")!;
      const alert = dialog.querySelector("[role=alert]")!;
      expect(
        [
          ...alert.querySelectorAll(
            "[data-slot=alert-title], [data-slot=alert-description]",
          ),
        ].map((line) => line.textContent),
      ).toEqual([title, "It isn't there any more."]);
      expect(button(submit).disabled).toBe(false);
    },
  );

  it("does not offer force for another device when an earlier removal fails late", async () => {
    devices.push(light("second", "Light 2"));
    await show(admin);
    await choose("Light: more", "Remove");
    const answer = pendingReply<never>();
    vi.mocked(coreJson).mockImplementationOnce(() => answer.promise);
    await act(async () => button("Remove").click());
    await act(async () => button("Cancel").click());
    await choose("Light 2: more", "Remove");
    await act(async () => answer.reject(new CoreError(500, "app_failed")));
    expect(button("Remove anyway")).toBeUndefined();
    expect(document.querySelector("[role=dialog]")!.textContent).toContain(
      "Remove Light 2?",
    );
    await act(async () => button("Remove").click());
    expect(requests).toContainEqual({
      path: "/api/devices/remove",
      json: { id: "second", force: false },
    });
  });

  it("does not close a later dialog when an earlier removal succeeds late", async () => {
    devices.push(light("second", "Light 2"));
    await show(admin);
    await choose("Light: more", "Remove");
    const answer = pendingReply<{ id: string }>();
    vi.mocked(coreJson).mockImplementationOnce(() => answer.promise);
    await act(async () => button("Remove").click());
    await act(async () => button("Cancel").click());
    await choose("Light 2: more", "Rename");
    await act(async () => answer.resolve({ id: "desk" }));
    expect(document.querySelector("[role=dialog]")?.textContent).toContain(
      "Rename this device",
    );
  });
});
