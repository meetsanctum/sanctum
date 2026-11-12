import { NotReady } from "@meetsanctum/app-sdk";

import type { ZigbeeMessage } from "./types.js";
import { parseJson } from "./values.js";

// A start waits for the first device list to be registered and said to the
// core. Missing the list is retryable; a failure to say it to the core isn't.
export function createFirstList(withinMs: number) {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  let arrived!: () => void;
  let hasConnected = false;
  const arrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const listed = new Promise<void>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  listed.catch(() => undefined);

  return {
    receive(message: ZigbeeMessage, base: string) {
      if (
        message.topic === `${base}/bridge/devices` &&
        Array.isArray(parseJson(message.payload))
      ) {
        arrived();
      }
    },
    connected() {
      hasConnected = true;
    },
    taken(error?: string) {
      if (error === undefined) {
        resolve();
      } else {
        reject(new Error(`could not say which devices are here (${error})`));
      }
    },
    disconnected() {
      // A broker that won't have it brings no list: wait no longer for one.
      if (!hasConnected) reject(new NotReady("Waiting for Zigbee2MQTT"));
    },
    close() {
      reject(new Error("the Zigbee app stopped"));
    },
    async wait() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, refuse) => {
        timer = setTimeout(
          () => refuse(new NotReady("Waiting for Zigbee2MQTT")),
          withinMs,
        );
      });
      try {
        await Promise.race([arrival, listed, late]);
      } finally {
        clearTimeout(timer);
      }
      // The core bounds the whole start; the timer only bounds a missing list.
      await listed;
    },
  };
}
