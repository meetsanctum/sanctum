import type { DeviceInfo, Places } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import {
  createEventBus,
  type BusEvent,
  type EventBusFollower,
} from "../src/event-bus.js";

// The core's event bus (event-bus.ts), with followers that only say what
// they heard.

const lamp = { id: "lamp", name: "Lamp" } as DeviceInfo;
const places = {
  home: {
    name: "Home",
    timeZone: "UTC",
    temperatureUnit: "celsius",
    hourCycle: "24h",
  },
  floors: [],
  rooms: [],
  zones: [],
} satisfies Places;

const lampChanged: BusEvent = {
  name: "device.changed",
  id: "lamp",
  before: null,
  after: lamp,
};
const placesChanged: BusEvent = {
  name: "places.changed",
  before: places,
  after: places,
};
const pressed: BusEvent = {
  name: "device.pressed",
  id: "press-1",
  device: lamp,
  capability: "button",
  action: "single",
  at: new Date(0),
  isCaptured: false,
};

function busOf() {
  const logs: string[] = [];
  const heard: string[] = [];
  const bus = createEventBus({ log: (line) => logs.push(line) });
  // A follower that says it heard each event it follows.
  const hearing = (
    label: string,
    names: readonly BusEvent["name"][],
  ): readonly [string, EventBusFollower] => [
    label,
    Object.fromEntries(
      names.map((name) => [
        name,
        (event: BusEvent) => void heard.push(`${label}: ${event.name}`),
      ]),
    ),
  ];
  return { bus, logs, heard, hearing };
}

describe("the core's event bus", () => {
  it("hands each event to its followers in the order they were set, each only what it follows", () => {
    const { bus, heard, hearing } = busOf();
    bus.setFollowers([
      hearing("holds", ["device.pressed"]),
      hearing("live updates", ["device.changed", "device.pressed"]),
      hearing("history", ["device.changed"]),
    ]);

    bus.publish(pressed);
    bus.publish(lampChanged);

    expect(heard).toEqual([
      "holds: device.pressed",
      "live updates: device.pressed",
      "live updates: device.changed",
      "history: device.changed",
    ]);
  });

  it.each([
    { error: new Error("the rules fell over"), message: "the rules fell over" },
    { error: Object.create(null), message: "unprintable error" },
  ])(
    "goes on to the next follower when one throws $message, and says which in its words",
    ({ error, message }) => {
      const { bus, logs, heard, hearing } = busOf();
      bus.setFollowers([
        [
          "workflows",
          {
            "device.changed": () => {
              throw error;
            },
          },
        ],
        hearing("history", ["device.changed"]),
      ]);

      expect(() => bus.publish(lampChanged)).not.toThrow();

      expect(heard).toEqual(["history: device.changed"]);
      expect(logs).toEqual([
        `workflows: a change of lamp was not handled (${message})`,
      ]);
    },
  );

  it("hands on what a follower publishes once the event it handles has reached every follower", () => {
    const { bus, heard, hearing } = busOf();
    bus.setFollowers([
      [
        "device names",
        {
          "places.changed": (event) => {
            heard.push(`device names: ${event.name}`);
            bus.publish(lampChanged);
            heard.push("device names: published");
          },
        },
      ],
      hearing("live updates", ["places.changed", "device.changed"]),
    ]);

    bus.publish(placesChanged);

    expect(heard).toEqual([
      "device names: places.changed",
      "device names: published",
      "live updates: places.changed",
      "live updates: device.changed",
    ]);
  });

  it("hands on what a follower published before it threw", () => {
    const { bus, logs, heard, hearing } = busOf();
    bus.setFollowers([
      [
        "device names",
        {
          "places.changed": () => {
            bus.publish(lampChanged);
            throw new Error("no room");
          },
        },
      ],
      hearing("history", ["device.changed"]),
    ]);

    bus.publish(placesChanged);

    expect(heard).toEqual(["history: device.changed"]);
    expect(logs).toEqual([
      "device names: a change of the places was not handled (no room)",
    ]);
  });

  it("holds what's published before its followers are set, says so, and hands it on first", () => {
    const { bus, logs, heard, hearing } = busOf();
    expect(bus.state()).toBe("waitingForFollowers");

    bus.publish(lampChanged);
    expect(logs).toEqual([
      "events: device.changed was published before the followers were set",
    ]);
    bus.setFollowers([
      hearing("history", ["device.changed", "device.pressed"]),
    ]);
    bus.publish(pressed);

    expect(bus.state()).toBe("open");
    expect(heard).toEqual([
      "history: device.changed",
      "history: device.pressed",
    ]);
  });

  it("sets its followers once", () => {
    const { bus } = busOf();
    bus.setFollowers([]);

    expect(() => bus.setFollowers([])).toThrow(
      "the bus's followers are set once",
    );
  });

  it("drops what's published once it has closed, and says so", () => {
    const { bus, logs, heard, hearing } = busOf();
    bus.setFollowers([hearing("history", ["device.changed"])]);

    bus.close();
    bus.publish(lampChanged);

    expect(bus.state()).toBe("closed");
    expect(heard).toEqual([]);
    expect(logs).toEqual([
      "events: device.changed was published after the bus closed",
    ]);
  });

  it("says what was published before followers it never got", () => {
    const { bus, logs } = busOf();
    bus.publish(lampChanged);

    bus.close();

    expect(logs).toEqual([
      "events: device.changed was published before the followers were set",
      "events: 1 published before the followers were set never went out",
    ]);
  });

  it.each([
    { error: new Error("too late"), message: "too late" },
    { error: Object.create(null), message: "unprintable error" },
  ])(
    "doesn't wait for a handler that returns a promise, and catches its failure $message",
    async ({ error, message }) => {
      const { bus, logs, heard, hearing } = busOf();
      let fail!: () => void;
      const failing = new Promise<void>(
        (_resolve, reject) => (fail = () => reject(error)),
      );
      bus.setFollowers([
        ["dashboards", { "device.changed": (() => failing) as () => void }],
        hearing("history", ["device.changed"]),
      ]);

      bus.publish(lampChanged);
      expect(heard).toEqual(["history: device.changed"]);
      fail();
      await failing.catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));

      expect(logs).toEqual([
        "events: dashboards returned a promise for device.changed, which the bus doesn't wait for",
        `dashboards: a change of lamp was not handled (${message})`,
      ]);
    },
  );

  it("hands on an event when its log fails", () => {
    const heard: string[] = [];
    const bus = createEventBus({
      log: () => {
        throw new Error("the disk is full");
      },
    });
    bus.setFollowers([
      [
        "workflows",
        {
          "device.changed": () => {
            throw new Error("the rules fell over");
          },
        },
      ],
      ["history", { "device.changed": () => void heard.push("history") }],
    ]);

    expect(() => bus.publish(lampChanged)).not.toThrow();
    expect(heard).toEqual(["history"]);
  });
});
