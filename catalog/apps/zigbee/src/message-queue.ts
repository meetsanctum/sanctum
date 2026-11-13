import type { ZigbeeMessage } from "./types.js";

// Messages wait here while the driver handles them one at a time, in order,
// since each may call the core. A message that only says what something is
// now (the device list, the bridge's state and info, a device's
// availability) replaces any older one of its topic still waiting, and the
// queue holds a bounded number, dropping retained and replaceable messages
// first.
//
// Live messages do not go before retained ones. The driver subscribes to
// each device's topics once it knows the device, so little is retained, and
// it keeps the order: a device's retained availability, older than any live
// message after it, cannot overwrite what that message said.

export const messageQueueCapacity = 2_000;

export class MessageQueue {
  private readonly messages: ZigbeeMessage[] = [];

  constructor(private readonly baseTopic: string) {}

  get size() {
    return this.messages.length;
  }

  /** Adds a message; says how many waiting ones it replaced and how many were dropped. */
  enqueue(message: ZigbeeMessage) {
    let coalesced = 0;
    if (this.replaceable(message.topic)) {
      for (let index = this.messages.length - 1; index >= 0; index -= 1) {
        if (this.messages[index]?.topic === message.topic) {
          this.messages.splice(index, 1);
          coalesced += 1;
        }
      }
    }
    this.messages.push(message);
    return { coalesced, dropped: this.trimOverflow() };
  }

  next() {
    return this.messages.shift() ?? null;
  }

  clear() {
    this.messages.length = 0;
  }

  private trimOverflow() {
    let dropped = 0;
    while (this.messages.length > messageQueueCapacity) {
      const preferred = this.messages.findIndex(
        (message) => message.retained || this.replaceable(message.topic),
      );
      this.messages.splice(Math.max(preferred, 0), 1);
      dropped += 1;
    }
    return dropped;
  }

  private replaceable(topic: string) {
    const bridge = `${this.baseTopic}/bridge/`;
    if (topic.startsWith(bridge)) {
      return ["devices", "state", "info"].includes(topic.slice(bridge.length));
    }
    const device = topic.slice(this.baseTopic.length + 1);
    return (
      topic.startsWith(`${this.baseTopic}/`) &&
      device.endsWith("/availability") &&
      device.length > "/availability".length
    );
  }
}
