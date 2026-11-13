// @vitest-environment jsdom
import type { DeviceInfo, LivePress, Places } from "@meetsanctum/app-sdk";
import { AppScope, type PressCaptureListener } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PressChoice } from "../../src/presses/presses";
import type { Mood } from "../../src/ui/mood-draft";
import { PressesPage } from "../../src/ui/presses";
import { MoodsProvider } from "../../src/ui/state";
import { fakeClient } from "./support";

// The Presses page Moods adds to a remote's detail: what each press does,
// choosing it, and finding a press.

const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  rooms: [{ id: "office", name: "Office", floorId: null }],
  zones: [{ id: "upstairs", name: "Upstairs", roomIds: ["office"] }],
};

const remote: DeviceInfo = {
  id: "remote",
  name: "Office button",
  driverName: "Wireless mini switch",
  type: "button",
  driver: "sanctum.zigbee",
  manufacturer: "Aqara",
  model: "WXKG11LM",
  roomId: "office",
  availability: "online",
  lastSeenAt: null,
  firmware: null,
  probe: false,
  battery: null,
  leftAt: null,
  capabilities: [
    {
      id: "button",
      kind: "button",
      features: { actions: ["single", "double", "hold"], holds: ["hold"] },
      state: null,
      observed: null,
      desired: null,
      sync: "synced",
      setBy: null,
      changedAt: null,
    },
  ],
};

const evening: Mood = {
  id: "evening",
  roomId: "office",
  name: "Evening",
  icon: "armchair",
  smart: null,
  lights: [],
};

let root: Root;
let container: HTMLDivElement;
let client: ReturnType<typeof fakeClient>;
let chosen: Map<string, PressChoice>;
let listener: PressCaptureListener | undefined;
const stop = vi.fn(async () => {});

const officeToggle: PressChoice = {
  kind: "lights",
  place: { kind: "room", id: "office" },
  to: "toggle",
};

function listing() {
  return {
    presses: ["single", "double", "hold"].map((action) => ({
      action,
      choice: chosen.get(action) ?? null,
      default: (action === "hold"
        ? { ...officeToggle, to: "brightenOrDimWhileHeld" as const }
        : officeToggle) as PressChoice | null,
      hold: action === "hold",
    })),
    defaults: { roomId: "office", dimmer: false },
  };
}

let listed: () => ReturnType<typeof listing> = listing;

async function show(
  currentPlaces = places,
  shown: DeviceInfo = remote,
  devices: DeviceInfo[] = [shown],
  // What Moods holds, when a test takes some of it away.
  permissions?: string[],
) {
  client = fakeClient();
  if (permissions) client.app.permissions = permissions;
  client.devices.mockResolvedValue(devices);
  client.places.mockResolvedValue(currentPlaces);
  client.capturePresses.mockImplementation(
    (_device: string, each: PressCaptureListener) => {
      listener = each;
      return { stop };
    },
  );
  client.call.mockImplementation(
    async (
      action: string,
      input: { action: string; choice: PressChoice | null },
    ) => {
      if (action === "moods.moods") return [evening];
      if (action === "moods.choosePress") {
        if (input.choice) chosen.set(input.action, input.choice);
        else chosen.delete(input.action);
      }
      return listed();
    },
  );
  await act(async () => {
    root.render(
      <AppScope client={client}>
        <MoodsProvider>
          <PressesPage device={shown} />
        </MoodsProvider>
      </AppScope>,
    );
  });
}

const text = () => container.textContent ?? "";
const button = (name: string) => {
  const found = [...container.querySelectorAll("button")].find((each) =>
    (each.textContent ?? "").startsWith(name),
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
};
const click = (element: HTMLElement) =>
  act(async () => {
    element.click();
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  chosen = new Map();
  listed = listing;
  listener = undefined;
  stop.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("a remote's presses", () => {
  it("ask for what they need once someone has switched presses off", async () => {
    await show(
      places,
      remote,
      [remote],
      ["places.read", "devices.control:light", "workflows.manage"],
    );

    expect(text()).toBe(
      "To run a mood or switch lights with this remote, Moods needs to see its presses.Choose presses",
    );
    await act(async () => button("Choose presses").click());
    expect(client.ask).toHaveBeenCalledWith(["devices.read:button"]);
  });

  it("say what is missing when only their automations are off", async () => {
    await show(
      places,
      remote,
      [remote],
      ["places.read", "devices.control:light", "devices.read:button"],
    );

    expect(text()).toBe(
      "To run a mood or switch lights with this remote, Moods needs to keep the automations its presses run.Choose presses",
    );
    await act(async () => button("Choose presses").click());
    expect(client.ask).toHaveBeenCalledWith(["workflows.manage"]);
  });

  it("describes the defaults when the room name is unavailable", async () => {
    await show({ ...places, rooms: [] });
    expect(text()).toContain(
      "Presses you haven't chosen switch the room's lights on or off, and a hold brightens or dims them.",
    );
    expect(text()).not.toContain("Its's");
  });

  it("say what each does, by default while it is not chosen", async () => {
    await show();

    expect(
      [...container.querySelectorAll("li")].map((each) => each.textContent),
    ).toEqual([
      "Single pressOffice lights on or off",
      "Double pressOffice lights on or off",
      "HoldBrighten or dim Office lights while held",
    ]);
    expect(container.querySelector("h2")?.textContent).toBe(
      "When it's pressed",
    );
    expect(text()).toContain(
      "Presses you haven't chosen switch Office's lights on or off, and a hold brightens or dims them.",
    );
  });

  it("open a page of their own, where a choice applies at once", async () => {
    await show();
    await click(button("Double press"));

    expect(container.querySelector("h2")?.textContent).toBe("Double press");
    const options = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ].map((each) => each.textContent);
    expect(options).toEqual([
      "Nothing",
      "On",
      "On or off",
      "Off",
      "Brighter",
      "Dimmer",
      "Evening",
    ]);
    expect(button("Which lights").textContent).toBe("Which lightsOffice");

    expect(button("On or off").getAttribute("aria-checked")).toBe("true");
    await click(button("Brighter"));
    expect(client.call).toHaveBeenLastCalledWith("moods.choosePress", {
      device: "remote",
      action: "double",
      choice: { ...officeToggle, to: "brighter" },
    });
    await click(button("Evening"));

    expect(client.call).toHaveBeenCalledWith("moods.choosePress", {
      device: "remote",
      action: "double",
      choice: { kind: "mood", moodId: "evening" },
    });
    expect(button("Evening").getAttribute("aria-checked")).toBe("true");

    await click(button("Presses"));
    expect(
      [...container.querySelectorAll("li")].map((each) => each.textContent),
    ).toEqual([
      "Single pressOffice lights on or off",
      "Double pressEvening",
      "HoldBrighten or dim Office lights while held",
    ]);
  });

  it("can be found by pressing the remote, which switches nothing meanwhile", async () => {
    await show();
    await click(button("Find a press"));

    expect(client.capturePresses).toHaveBeenCalledWith(
      "remote",
      expect.anything(),
    );
    expect(text()).toContain("Press a button on the remote");
    await act(async () => {
      listener!.press({
        type: "press",
        device: "remote",
        capability: "button",
        action: "hold",
        at: "2026-10-30T12:00:00.000Z",
        isCaptured: true,
      } satisfies LivePress);
    });
    expect(text()).toContain("That was a hold");
    expect(container.querySelector("[data-heard]")?.textContent).toBe(
      "HoldBrighten or dim Office lights while heldJust pressed",
    );

    await click(button("Stop"));
    expect(stop).toHaveBeenCalled();
    expect(text()).not.toContain("Just pressed");
    expect(button("Find a press")).toBeTruthy();
  });

  it("refreshes the choices when the live connection returns", async () => {
    await show();
    chosen.set("double", { kind: "mood", moodId: "evening" });
    await act(async () => {
      for (const [listener] of client.subscribe.mock.calls)
        listener.refresh?.();
    });
    expect(
      [...container.querySelectorAll("li")].map((each) => each.textContent),
    ).toEqual([
      "Single pressOffice lights on or off",
      "Double pressEvening",
      "HoldBrighten or dim Office lights while held",
    ]);
  });

  it("ignores an older refresh that arrives after a newer choice", async () => {
    await show();
    const originalCall = client.call.getMockImplementation()!;
    const older = listing();
    let release!: () => void;
    let isHeld = true;
    client.call.mockImplementation((action, input) => {
      if (action === "moods.presses" && isHeld) {
        isHeld = false;
        return new Promise((resolve) => {
          release = () => resolve(older);
        });
      }
      return originalCall(action, input);
    });
    await act(async () => {
      for (const [listener] of client.subscribe.mock.calls)
        listener.refresh?.();
    });
    await click(button("Double press"));
    await click(button("Evening"));
    await act(async () => release());
    expect(button("Evening").getAttribute("aria-checked")).toBe("true");
  });

  it("waits for a choice to save before accepting another", async () => {
    await show();
    await click(button("Double press"));
    const originalCall = client.call.getMockImplementation()!;
    let release!: () => void;
    client.call.mockImplementation((action, input) => {
      if (action === "moods.choosePress") {
        return new Promise((resolve) => {
          release = () => resolve(originalCall(action, input));
        });
      }
      return originalCall(action, input);
    });
    await click(button("Evening"));
    expect(button("Nothing").disabled).toBe(true);
    await click(button("Nothing"));
    expect(
      client.call.mock.calls.filter(
        ([action]) => action === "moods.choosePress",
      ),
    ).toHaveLength(1);
    await act(async () => release());
    expect(button("Evening").getAttribute("aria-checked")).toBe("true");
    expect(button("Nothing").disabled).toBe(false);
  });

  it.each(["refresh", "choice"])(
    "clears a load error after a successful %s",
    async (recovery) => {
      await show();
      const originalCall = client.call.getMockImplementation()!;
      let isFailing = true;
      client.call.mockImplementation((action, input) => {
        if (action === "moods.presses" && isFailing)
          return Promise.reject(new Error("offline"));
        return originalCall(action, input);
      });
      await act(async () => {
        for (const [listener] of client.subscribe.mock.calls)
          listener.refresh?.();
      });
      expect(text()).toContain("Couldn't read the presses.");
      isFailing = false;
      if (recovery === "refresh") {
        await act(async () => {
          for (const [listener] of client.subscribe.mock.calls)
            listener.refresh?.();
        });
      } else {
        await click(button("Double press"));
        await click(button("Evening"));
      }
      expect(text()).not.toContain("Couldn't read the presses.");
    },
  );

  it("retries a late capture failure without stopping a newer session", async () => {
    await show();
    await click(button("Find a press"));
    const earlier = listener!;
    await click(button("Stop"));
    await click(button("Find a press"));
    const current = listener!;
    await act(async () => earlier.ended?.("failed"));
    expect(stop).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Press a button on the remote");
    expect(text()).not.toContain("Couldn't listen");
    expect(listener).toBe(current);
    await click(button("Stop"));
    expect(stop).toHaveBeenCalledTimes(3);
  });

  it("retries capture release after the detail closes", async () => {
    await show();
    await click(button("Find a press"));
    vi.useFakeTimers();
    try {
      stop.mockRejectedValueOnce(new Error("offline"));
      await act(async () => root.unmount());
      expect(stop).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stop).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a saved light target after the remote moves to another room", async () => {
    chosen.set("double", {
      kind: "lights",
      place: { kind: "room", id: "previous" },
      to: "toggle",
    });
    await show({
      ...places,
      rooms: [
        ...places.rooms,
        { id: "previous", name: "Kitchen", floorId: null },
      ],
    });
    await click(button("Double press"));
    expect(button("On or off").getAttribute("aria-checked")).toBe("true");
    expect(button("Which lights").textContent).toBe("Which lightsKitchen");
    await click(button("Which lights"));
    expect(
      container.querySelector('[role="radio"][aria-checked="true"]')
        ?.textContent,
    ).toBe("Kitchen");
  });

  it("retries a failed Stop before opening a press", async () => {
    await show();
    await click(button("Find a press"));
    stop.mockRejectedValueOnce(new Error("offline"));
    await click(button("Double press"));
    expect(text()).toContain("Couldn't stop listening. Try Stop again.");
    expect(container.querySelector("h2")?.textContent).toBe(
      "When it's pressed",
    );
    expect(button("Stop")).toBeTruthy();
    await click(button("Stop"));
    expect(stop).toHaveBeenCalledTimes(2);
    expect(text()).not.toContain("Couldn't stop listening");
    expect(button("Find a press")).toBeTruthy();
  });

  it("say when listening could not start", async () => {
    await show();
    await click(button("Find a press"));
    await act(async () => listener!.ended?.("failed"));

    expect(text()).toContain("Couldn't listen for the remote. Try again.");
  });
});

// An office dimmer, a Hue dimmer switch gen 1, and the lights it can
// choose from: two in the office, one that cannot dim, and one in the
// living room.
const dimmer: DeviceInfo = {
  ...remote,
  id: "dimmer",
  name: "Office dimmer",
  driverName: "Hue dimmer switch",
  model: "RWL021",
  capabilities: [
    {
      id: "button",
      kind: "button",
      features: {
        actions: ["on", "up", "down", "off"].flatMap((each) => [
          `${each}_press`,
          `${each}_hold`,
        ]),
        holds: ["on_hold", "up_hold", "down_hold", "off_hold"],
      },
      state: null,
      observed: null,
      desired: null,
      sync: "synced",
      setBy: null,
      changedAt: null,
    },
  ],
};

function light(
  id: string,
  name: string,
  roomId: string,
  state: { on: boolean; brightness?: number },
  brightness = true,
): DeviceInfo {
  return {
    ...remote,
    id,
    name,
    roomId,
    capabilities: [
      {
        id: "light",
        kind: "light",
        features: { brightness, colorTemperature: null, color: false },
        state,
        observed: state,
        desired: null,
        sync: "synced",
        setBy: null,
        changedAt: null,
      },
    ],
  };
}

const lights = [
  light("desk", "Desk lamp", "office", { on: true, brightness: 45 }),
  light("ceiling", "Office light", "office", { on: true, brightness: 80 }),
  light("shelf", "Shelf", "office", { on: false }, false),
  light("floor", "Floor lamp", "living", { on: false, brightness: 100 }),
];
const home: Places = {
  ...places,
  rooms: [
    { id: "living", name: "Living room", floorId: null },
    ...places.rooms,
  ],
};

const officeTo = (to: string) => ({
  kind: "lights" as const,
  place: { kind: "room" as const, id: "office" },
  to,
});

function dimmerListing() {
  const defaults: Record<string, string> = {
    on: "on",
    up: "brighter",
    down: "dimmer",
    off: "off",
  };
  return {
    presses:
      dimmer.capabilities[0]!.kind === "button"
        ? dimmer.capabilities[0]!.features.actions.map((action) => {
            const [button, press] = action.split("_") as [string, string];
            const hold = press === "hold";
            const to =
              hold && button === "up"
                ? "brightenWhileHeld"
                : hold && button === "down"
                  ? "dimWhileHeld"
                  : defaults[button]!;
            // Holding on or off is there to choose.
            const nothing = hold && (button === "on" || button === "off");
            return {
              action,
              choice: chosen.get(action) ?? null,
              default: nothing ? null : (officeTo(to) as PressChoice),
              hold,
            };
          })
        : [],
    defaults: { roomId: "office", dimmer: true },
  };
}

describe("a dimmer's presses", () => {
  beforeEach(() => {
    listed = dimmerListing;
  });

  it("are grouped by button, a dimmer for its room by default", async () => {
    await show(home, dimmer, [dimmer, ...lights]);

    expect(
      [...container.querySelectorAll("h2")].map((each) => each.textContent),
    ).toEqual(["On button", "Up button", "Down button", "Off button"]);
    expect(
      [...container.querySelectorAll("li")].map((each) => each.textContent),
    ).toEqual([
      "PressOffice lights on",
      "HoldNothing",
      "PressOffice lights brighter",
      "HoldBrighten Office lights while held",
      "PressOffice lights dimmer",
      "HoldDim Office lights while held",
      "PressOffice lights off",
      "HoldNothing",
    ]);
    expect(text()).toContain(
      "Presses you haven't chosen work as a dimmer for Office.",
    );
  });

  it("offer a hold what it can do while held", async () => {
    await show(home, dimmer, [dimmer, ...lights]);
    const holds = [...container.querySelectorAll("li button")];
    await click(holds[3] as HTMLButtonElement);

    expect(container.querySelector("h2")?.textContent).toBe("Up button, hold");
    expect(
      [
        ...container.querySelectorAll(
          '[aria-labelledby="lights-heading"][role="radiogroup"] [role="radio"]',
        ),
      ].map((each) => each.textContent),
    ).toEqual([
      "On",
      "On or off",
      "Off",
      "Brighten while held",
      "Dim while held",
      "Brighten or dim while held",
    ]);
    expect(button("Brighten while held").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(text()).toContain(
      "Brighten or dim takes turns: each hold goes the other way.",
    );
    await click(button("Dim while held"));
    expect(client.call).toHaveBeenLastCalledWith("moods.choosePress", {
      device: "dimmer",
      action: "up_hold",
      choice: officeTo("dimWhileHeld"),
    });
  });

  it("choose some lights by room, the remote's room first, saving each change", async () => {
    await show(home, dimmer, [dimmer, ...lights]);
    await click(
      [...container.querySelectorAll("li button")][3] as HTMLButtonElement,
    );
    await click(button("Which lights"));

    expect(container.querySelector("h2")?.textContent).toBe("Which lights");
    expect(
      [...container.querySelectorAll('[role="radio"]')].map(
        (each) => each.textContent,
      ),
    ).toEqual(["Office", "Upstairs", "All lights", "Some lights"]);
    await click(button("Some lights"));

    expect(
      [...container.querySelectorAll("h3")].map((each) => each.textContent),
    ).toEqual(["Office", "Living room"]);
    expect(
      [...container.querySelectorAll('[role="checkbox"]')].map((each) => [
        each.textContent,
        each.getAttribute("aria-checked"),
      ]),
    ).toEqual([
      ["Desk lampOn · 45%", "true"],
      ["Office lightOn · 80%", "true"],
      ["ShelfOff · Can't dim", "true"],
      ["Floor lampOff", "false"],
    ]);
    expect(text()).toContain(
      "Lights that can't dim are left alone when a press brightens or dims them.",
    );

    await click(button("Shelf"));
    expect(client.call).toHaveBeenLastCalledWith("moods.choosePress", {
      device: "dimmer",
      action: "up_hold",
      choice: {
        kind: "lights",
        place: {
          kind: "lights",
          lights: [
            { device: "ceiling", capability: "light" },
            { device: "desk", capability: "light" },
          ],
        },
        to: "brightenWhileHeld",
      },
    });
    expect(text()).toContain("Brighten Office light and Desk lamp while held.");
    expect(text()).not.toContain("Lights that can't dim");
    await click(button("Up button, hold"));
    expect(button("Which lights").textContent).toBe(
      "Which lightsOffice light and Desk lamp",
    );
  });

  it("keeps the saved light selection after a failed change", async () => {
    await show(home, dimmer, [dimmer, ...lights]);
    await click(
      [...container.querySelectorAll("li button")][3] as HTMLButtonElement,
    );
    await click(button("Which lights"));
    await click(button("Some lights"));
    client.call.mockRejectedValueOnce(new Error("save failed"));
    await click(button("Shelf"));
    expect(text()).toContain("Couldn't change that press");
    expect(button("Shelf").getAttribute("aria-checked")).toBe("true");
  });

  it("refreshes an open light picker before saving its next change", async () => {
    await show(home, dimmer, [dimmer, ...lights]);
    await click(
      [...container.querySelectorAll("li button")][3] as HTMLButtonElement,
    );
    await click(button("Which lights"));
    await click(button("Some lights"));

    // Another client changed the choice while this one was disconnected.
    chosen.set("up_hold", {
      kind: "lights",
      place: {
        kind: "lights",
        lights: [{ device: "floor", capability: "light" }],
      },
      to: "brightenWhileHeld",
    });
    await act(async () => {
      for (const [listener] of client.subscribe.mock.calls)
        listener.refresh?.();
    });
    expect(button("Floor lamp").getAttribute("aria-checked")).toBe("true");
    expect(button("Desk lamp").getAttribute("aria-checked")).toBe("false");

    await click(button("Desk lamp"));
    expect(chosen.get("up_hold")).toMatchObject({
      place: {
        kind: "lights",
        lights: [
          { device: "desk", capability: "light" },
          { device: "floor", capability: "light" },
        ],
      },
    });
  });

  it("say the press Find a press heard by its button", async () => {
    await show(home, dimmer, [dimmer, ...lights]);
    await click(button("Find a press"));
    await act(async () => {
      listener!.press({
        type: "press",
        device: "dimmer",
        capability: "button",
        action: "up_hold",
        at: "2026-10-31T12:00:00.000Z",
        isCaptured: true,
      } satisfies LivePress);
    });

    expect(text()).toContain("That was the up button's hold");
  });
});
