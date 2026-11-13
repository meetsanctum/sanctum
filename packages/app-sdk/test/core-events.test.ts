import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createAppContext,
  type CoreCalls,
  type CoreEvent,
  type CoreEventHandlers,
  type Room,
} from "../src/index.js";

// ctx.events.on(): the start context keeps an app's handlers on its side of
// the boundary and asks the core for the event by name, which the core may
// refuse.

const unused = async (): Promise<never> => {
  throw new Error("not in this test");
};

function context(follow: CoreCalls["follow"], handlers?: CoreEventHandlers) {
  const core: CoreCalls = {
    query: unused,
    serviceConnection: unused,
    settings: unused,
    permissions: unused,
    permissionsRevision: unused,
    people: unused,
    places: unused,
    devices: unused,
    device: unused,
    command: unused,
    register: unused,
    report: unused,
    present: unused,
    press: unused,
    release: unused,
    emit: unused,
    follow,
    scheduleJob: unused,
    cancelJob: unused,
    jobs: unused,
    putWorkflow: unused,
    removeWorkflow: unused,
    workflows: unused,
    location: unused,
    publish: unused,
    unpublish: unused,
    entities: unused,
    fetch: unused,
    firmware: unused,
    joining: unused,
    secret: unused,
    putSecret: unused,
    removeSecret: unused,
    log() {},
  };
  return createAppContext({
    appId: "test.app",
    actor: { kind: "app", id: "test.app" },
    core,
    handlers,
  });
}

const office: Room = { id: "office", name: "Office", floorId: null };

describe("ctx.events.on", () => {
  it("keeps the handler by the event's name once the core lets the app follow it", async () => {
    const followed: string[] = [];
    const handlers: CoreEventHandlers = new Map();
    const ctx = context(async (name) => void followed.push(name), handlers);
    const deleted: string[] = [];

    await ctx.events.on("place.deleted", ({ place }) => {
      expectTypeOf(place.kind).toEqualTypeOf<
        "home" | "floor" | "room" | "zone"
      >();
      deleted.push(place.kind);
    });
    const event: CoreEvent = {
      name: "place.deleted",
      place: { kind: "room", ...office },
    };
    for (const handler of handlers.get("place.deleted") ?? []) {
      await handler(event);
    }

    expect(followed).toEqual(["place.deleted"]);
    expect(deleted).toEqual(["room"]);
  });

  it("drops the handler when the core refuses", async () => {
    const handlers: CoreEventHandlers = new Map();
    const ctx = context(async () => {
      throw new Error("test.app does not hold places.read");
    }, handlers);

    await expect(ctx.events.on("place.added", () => {})).rejects.toThrow(
      "places.read",
    );
    expect(handlers.get("place.added")).toEqual([]);
  });

  it("is for the start context only", async () => {
    const followed: string[] = [];
    const ctx = context(async (name) => void followed.push(name));

    await expect(ctx.events.on("device.changed", () => {})).rejects.toThrow(
      "Only the start hook's context follows events",
    );
    expect(followed).toEqual([]);
  });
});
