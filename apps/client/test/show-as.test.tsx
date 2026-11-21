// @vitest-environment jsdom
import type { DeviceInfo, DeviceType } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceMenu } from "../src/device-menu";
import { showAsOf } from "../src/device-parts";
import { light, office } from "./settings-devices-fixtures";

// Show as: what the household may show a device as, in its menu in
// Settings → Devices and beside its room in Add devices.

const lamp = light("desk", "Light");
const sensor: DeviceInfo = {
  ...light("hall", "Hall contact sensor"),
  type: "contact",
  shownAs: null,
  capabilities: [],
};
const door: DeviceInfo = {
  ...sensor,
  name: "Hall door",
  type: "door",
  shownAs: "door",
};

describe("what a device may be shown as", () => {
  it("is its own type first, then the types it lists, by their titles", () => {
    expect(showAsOf(sensor)).toMatchObject({
      current: "contact",
      options: [
        { id: "contact", title: "Contact sensor" },
        { id: "door", title: "Door" },
        { id: "window", title: "Window" },
      ],
    });
    // The same for one shown as a door, with the door in effect.
    expect(showAsOf(door)).toMatchObject({
      current: "door",
      options: [
        { id: "contact", title: "Contact sensor" },
        { id: "door", title: "Door" },
        { id: "window", title: "Window" },
      ],
    });
  });

  it("saves no choice for the device's own type", () => {
    const showAs = showAsOf(door)!;
    expect(showAs.choice("window")).toBe("window");
    expect(showAs.choice("door")).toBe("door");
    expect(showAs.choice("contact")).toBeNull();
    expect(showAs.choice("light")).toBeNull();
  });

  it("is nothing for a device that can only be shown as what it is", () => {
    expect(showAsOf(lamp)).toBeNull();
  });
});

describe("Show as, where it is chosen", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const enter = (element: Element) =>
    act(async () =>
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );

  const items = (role: string) => [
    ...document.querySelectorAll<HTMLElement>(`[role=${role}]`),
  ];

  const trigger = (label: string) =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

  async function showMenu(device: DeviceInfo) {
    const onShowAs = vi.fn<(shownAs: DeviceType | null) => void>();
    const nothing = () => undefined;
    await act(async () =>
      root.render(
        <DeviceMenu
          device={device}
          rooms={[office]}
          onKeep={nothing}
          onHome={nothing}
          onEdit={nothing}
          onRoom={nothing}
          onShowAs={onShowAs}
          onMotion={nothing}
          onCheck={nothing}
          onProbe={nothing}
          onStop={nothing}
        />,
      ),
    );
    return onShowAs;
  }

  it("is one level down in a contact sensor's menu, with a mark on the one in effect", async () => {
    const onShowAs = await showMenu(door);
    await enter(trigger("Hall door: more"));
    const sub = items("menuitem").find(
      (each) => each.textContent === "Show as",
    )!;
    expect(sub.getAttribute("aria-haspopup")).toBe("menu");

    await enter(sub);
    const options = items("menuitemradio").filter((each) =>
      ["Contact sensor", "Door", "Window"].includes(each.textContent ?? ""),
    );
    expect(options.map((each) => each.textContent)).toEqual([
      "Contact sensor",
      "Door",
      "Window",
    ]);
    expect(options.map((each) => each.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    await act(async () => options[2]!.click());
    expect(onShowAs).toHaveBeenCalledExactlyOnceWith("window");
  });

  it("is not in the menu of a device that can only be shown as what it is", async () => {
    await showMenu(lamp);
    await enter(trigger("Light: more"));
    expect(items("menuitem").map((each) => each.textContent)).not.toContain(
      "Show as",
    );
    expect(items("menuitem").map((each) => each.textContent)).toContain("Room");
  });
});
