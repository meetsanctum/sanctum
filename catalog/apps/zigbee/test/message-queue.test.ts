import { describe, expect, it } from "vitest";

import { MessageQueue, messageQueueCapacity } from "../src/message-queue.js";

describe("the message queue", () => {
  it("coalesces replaceable bridge and availability topics with latest payloads", () => {
    const queue = new MessageQueue("zigbee2mqtt");

    queue.enqueue(message("zigbee2mqtt/bridge/devices", { revision: 1 }, true));
    queue.enqueue(message("zigbee2mqtt/bridge/devices", { revision: 2 }, true));
    queue.enqueue(message("zigbee2mqtt/bridge/state", "offline", true));
    queue.enqueue(message("zigbee2mqtt/bridge/state", "online", true));
    queue.enqueue(message("zigbee2mqtt/bridge/info", { version: 1 }, true));
    queue.enqueue(message("zigbee2mqtt/bridge/info", { version: 2 }, true));
    queue.enqueue(message("zigbee2mqtt/lamp/availability", "offline"));
    expect(
      queue.enqueue(message("zigbee2mqtt/lamp/availability", "online")),
    ).toEqual({ coalesced: 1, dropped: 0 });

    expect(queue.size).toBe(4);
    // In the order they came: a retained message is not older than one
    // that came after it, so it is not put behind it.
    expectPayload(queue.next(), { revision: 2 });
    expectPayload(queue.next(), "online");
    expectPayload(queue.next(), { version: 2 });
    expectPayload(queue.next(), "online");
    expect(queue.next()).toBeNull();
  });

  it("keeps every state message and bridge event", () => {
    const queue = new MessageQueue("zigbee2mqtt");

    queue.enqueue(message("zigbee2mqtt/lamp", { state: "ON" }));
    queue.enqueue(message("zigbee2mqtt/lamp", { state: "OFF" }));
    queue.enqueue(message("zigbee2mqtt/bridge/event", { type: "a" }));
    queue.enqueue(message("zigbee2mqtt/bridge/event", { type: "b" }));
    queue.enqueue(message("zigbee2mqtt/bridge/availability", "online"));
    queue.enqueue(message("zigbee2mqtt/bridge/availability", "online"));
    queue.enqueue(message("zigbee2mqtt/living/lamp/availability", "online"));
    queue.enqueue(message("zigbee2mqtt/living/lamp/availability", "online"));

    expect(queue.size).toBe(7);
  });

  it("caps non-coalescable messages and preserves remaining order", () => {
    const queue = new MessageQueue("zigbee2mqtt");

    for (let index = 0; index <= messageQueueCapacity; index += 1) {
      queue.enqueue(
        message("zigbee2mqtt/button", { action: `press-${index}` }),
      );
    }

    expect(queue.size).toBe(messageQueueCapacity);
    expectPayload(queue.next(), { action: "press-1" });
  });

  it("drops stale retained work before live non-coalescable work", () => {
    const queue = new MessageQueue("zigbee2mqtt");

    queue.enqueue(message("zigbee2mqtt/startup_sensor", { value: 0 }, true));
    for (let index = 0; index < messageQueueCapacity; index += 1) {
      queue.enqueue(
        message("zigbee2mqtt/button", { action: `press-${index}` }),
      );
    }

    expect(queue.size).toBe(messageQueueCapacity);
    expectPayload(queue.next(), { action: "press-0" });
  });
});

function message(topic: string, payload: unknown, retained = false) {
  return {
    topic,
    payload: Buffer.from(
      typeof payload === "string" ? payload : JSON.stringify(payload),
    ),
    retained,
  };
}

function expectPayload(
  queued: ReturnType<MessageQueue["next"]>,
  payload: unknown,
) {
  expect(queued).not.toBeNull();
  expect(queued?.payload.toString("utf8")).toBe(
    typeof payload === "string" ? payload : JSON.stringify(payload),
  );
}
