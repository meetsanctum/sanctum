import type { LiveMessage } from "@meetsanctum/app-sdk";
import {
  liveInvalidTokenCode,
  livePath,
  type LiveAuth,
} from "@meetsanctum/auth-protocol";

import { coreFetch, tokenFor } from "./core-fetch";
import { coreUrl } from "./core-url";

// The live-update WebSocket. It authenticates with its first message, with
// the token the fetch helper would send to the same core, and reconnects
// while the token is held, waiting longer each time, or at once when told
// the core is back. Once it is live, the core's updates reach onMessage,
// which hands them to the apps' pages (src/apps.tsx).

export type LiveState = "connecting" | "live" | "offline";

export function connectLive(
  onState: (state: LiveState) => void,
  onMessage: (message: LiveMessage) => void = () => undefined,
) {
  let stopped = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 1_000;

  const connect = () => {
    const url = new URL(coreUrl(livePath));
    const token = tokenFor(url);
    if (stopped || !token) {
      return;
    }
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    onState("connecting");
    socket = new WebSocket(url);
    socket.onopen = () =>
      socket?.send(JSON.stringify({ type: "auth", token } satisfies LiveAuth));
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as
        { type: "ready" } | LiveMessage;
      if (message.type === "ready") {
        delay = 1_000;
        onState("live");
      } else {
        onMessage(message);
      }
    };
    socket.onclose = (event) => {
      if (stopped) {
        return;
      }
      onState("offline");
      if (event.code === liveInvalidTokenCode) {
        // Ask once more over HTTP: the fetch helper forgets the token if the
        // core reports it invalid, and nothing else unpairs the device.
        void coreFetch("/api/auth/me").catch(() => undefined);
      }
      retry = setTimeout(() => {
        retry = undefined;
        connect();
      }, delay);
      delay = Math.min(delay * 2, 30_000);
    };
  };

  connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
    },
    // Reconnects now if it is waiting to.
    retryNow() {
      if (stopped || retry === undefined) {
        return;
      }
      clearTimeout(retry);
      retry = undefined;
      delay = 1_000;
      connect();
    },
  };
}
