// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { AddDevices } from "../src/add-devices";
import { CoreError, coreJson } from "../src/core-fetch";
import {
  core,
  example,
  joiningDevice,
  live,
  kitchenSensor,
  named,
  page,
  root,
  show,
  type,
  way,
} from "./add-devices-support";
import { light, office, zigbee } from "./settings-devices-fixtures";

describe("Add devices, with a device it added", () => {
  async function chooseInMenu(menu: string, item: string) {
    const trigger = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${menu}"]`,
    )!;
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    const found = [
      ...document.querySelectorAll<HTMLElement>(
        "[role=menuitem], [role=menuitemradio]",
      ),
    ].find((candidate) => candidate.textContent === item)!;
    await act(async () => found.click());
  }

  it("greets a device new to the home once, as its card turns green", async () => {
    const added = kitchenSensor();
    core.answers.kitchen = () => ({ added });
    core.devices = [added];
    await show();
    await way("Devices found");
    await act(async () => named("Add Kitchen sensor").click());

    expect(page().querySelector(".add-devices-sweep")).not.toBeNull();
    // A light's round glows as a bulb switching on.
    expect(page().querySelector(".add-devices-glow")).not.toBeNull();

    await act(async () => named("Back to Add devices").click());
    await way("Devices found");
    expect(page().querySelector('[aria-label="Added"]')).not.toBeNull();
    expect(page().querySelector(".add-devices-sweep")).toBeNull();
  });

  it("makes a new room in place and puts the device in it", async () => {
    const added = kitchenSensor();
    core.answers.kitchen = () => ({ added });
    core.devices = [added];
    const hall = { ...office, id: "hall", name: "Hall" };
    const answered = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
      if (path === "/api/places/rooms/add") {
        core.requests.push({ path, json: init.json });
        return hall;
      }
      const answer = await answered(path, init);
      return path === "/api/devices/update"
        ? { ...added, roomId: hall.id }
        : answer;
    });
    await show();
    await way("Devices found");
    await act(async () => named("Add Kitchen sensor").click());

    await chooseInMenu("Kitchen sensor: room", "New room…");
    const field = page().querySelector<HTMLInputElement>("form input")!;
    expect(field.labels![0]!.textContent).toBe("New room");
    expect(document.activeElement).toBe(field);
    await type(field, "Hall");
    await act(async () =>
      [...page().querySelectorAll("button")]
        .find((button) => button.textContent === "Add room")!
        .click(),
    );

    expect(core.requests).toContainEqual({
      path: "/api/places/rooms/add",
      json: { name: "Hall" },
    });
    expect(core.requests).toContainEqual({
      path: "/api/devices/update",
      json: { id: "sensor-1", roomId: "hall" },
    });
    // Back to the menu.
    expect(
      [...page().querySelectorAll("label")].map((label) => label.textContent),
    ).not.toContain("New room");
  });

  it("removes a device Sanctum can't use, after asking", async () => {
    const unusable = light("odd", "Unknown Device", { capabilities: [] });
    core.devices = [unusable];
    core.adding.joined = [
      { ...joiningDevice, stage: "ready", deviceId: unusable.id },
    ];
    const removed = vi.fn();
    await act(async () =>
      root.render(
        <AddDevices
          open
          onOpenChange={() => undefined}
          devices={core.devices}
          rooms={[office]}
          apps={[zigbee, example]}
          adding={core.adding}
          live={live}
          onChanged={() => undefined}
          onRemoved={removed}
        />,
      ),
    );
    await way("Zigbee");

    expect(page().textContent).toContain(
      "Sanctum can't use this device. Keep it in a room, or remove it.",
    );
    await act(async () => named("Remove Unknown Device").click());
    const asking = [...document.querySelectorAll("[role=dialog]")].at(-1)!;
    expect(asking.textContent).toContain("Remove Unknown Device?");
    await act(async () =>
      [...asking.querySelectorAll("button")]
        .find((button) => button.textContent === "Remove")!
        .click(),
    );

    expect(core.requests).toContainEqual({
      path: "/api/devices/remove",
      json: { id: "odd", force: false },
    });
    expect(removed).toHaveBeenCalledWith("odd");
  });

  it("has a ready device blink to show which it is, and says when it couldn't", async () => {
    // Blinking… lasts as long as a device takes to blink.
    vi.useFakeTimers({
      toFake: [
        "Date",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    const added = { ...kitchenSensor(), identify: true };
    core.answers.kitchen = () => ({ added });
    core.devices = [added];
    await show();
    await way("Devices found");
    await act(async () => named("Add Kitchen sensor").click());

    const blink = named("Blink Kitchen sensor");
    await act(async () => blink.click());
    expect(core.requests).toContainEqual({
      path: "/api/devices/identify",
      json: { id: "sensor-1" },
    });
    expect(blink.textContent).toBe("Blinking…");
    expect(blink.disabled).toBe(true);

    await act(async () => vi.advanceTimersByTime(2_500));
    expect(blink.textContent).toBe("Blink");
    for (const error of [
      new CoreError(503, "unavailable"),
      new CoreError(500, "app_failed"),
    ]) {
      vi.mocked(coreJson).mockRejectedValueOnce(error);
      await act(async () => blink.click());
      const alert = page().querySelector("[role=alert]")!;
      expect(
        [
          ...alert.querySelectorAll(
            "[data-slot=alert-title], [data-slot=alert-description]",
          ),
        ].map((line) => line.textContent),
      ).toEqual([
        "Kitchen sensor didn't blink",
        "Sanctum ran into a problem. Try again in a moment.",
      ]);
      expect(blink.textContent).toBe("Blink");
      expect(blink.disabled).toBe(false);
    }
  });

  it("offers no Blink for a device that can't show itself", async () => {
    const added = kitchenSensor();
    core.answers.kitchen = () => ({ added });
    core.devices = [added];
    await show();
    await way("Devices found");
    await act(async () => named("Add Kitchen sensor").click());

    expect(named("Blink Kitchen sensor")).toBeNull();
  });
});
