import type { CoreCalls } from "@meetsanctum/app-sdk";
import {
  createMessageReader,
  protocolVersion,
  type CoreMessage,
} from "@meetsanctum/app-sdk/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";

import { createAppLink, type AppLink } from "../src/app-host/link.js";

// The core's end of an app's socket, spoken to directly and with nothing of the
// SDK's runner in the way: only the SDK's rule keeps an app's own code off the
// socket, so it may say anything.

export const digest = "b".repeat(64);
export const person = { kind: "user", id: "maya" } as const;
export const welcomeHello = {
  type: "hello",
  protocol: protocolVersion,
  app: "test.link",
  version: "1.2.3",
  manifest: digest,
};

let folder: string;
export let socketPath: string;
export let link: AppLink;
export let gone: string[];
export let ready: number;
const clients: Socket[] = [];
export const logs: string[] = [];

type Options = Partial<Parameters<typeof createAppLink>[0]>;

export async function listening(options: Options = {}) {
  link = createAppLink({
    appId: "test.link",
    version: "1.2.3",
    manifest: digest,
    socket: socketPath,
    log: (message) => logs.push(message),
    onReady: () => (ready += 1),
    onGone: (reason) => gone.push(reason),
    ...options,
  });
  await link.listen();
  return link;
}

// An app as the socket sees it: whatever it sends, and everything it hears.
export async function appOnSocket() {
  const socket = connect(socketPath);
  clients.push(socket);
  await new Promise<void>((done, fail) => {
    socket.once("connect", done);
    socket.once("error", fail);
  });
  socket.on("error", () => undefined);
  const heard: CoreMessage[] = [];
  let closed = false;
  socket.on(
    "data",
    createMessageReader({
      message: (value) => heard.push(value as CoreMessage),
      violation: () => undefined,
    }),
  );
  socket.on("close", () => (closed = true));
  const app = {
    socket,
    heard,
    isClosed: () => closed,
    say: (message: unknown) => socket.write(`${JSON.stringify(message)}\n`),
    async hearing<Type extends CoreMessage["type"]>(type: Type, from = 0) {
      await vi.waitFor(() =>
        expect(heard.slice(from).some((message) => message.type === type)).toBe(
          true,
        ),
      );
      return heard
        .slice(from)
        .find((message) => message.type === type) as Extract<
        CoreMessage,
        { type: Type }
      >;
    },
    // Asks the core for one of its calls, naming a call, and waits for its reply.
    async ask(
      id: number,
      call: string,
      method: string,
      params: unknown[] = [],
    ) {
      app.say({ type: "request", id, call, method, params });
      await vi.waitFor(() =>
        expect(
          heard.some(
            (message) => message.type === "reply" && message.id === id,
          ),
        ).toBe(true),
      );
      return heard.find(
        (message) => message.type === "reply" && message.id === id,
      ) as Extract<CoreMessage, { type: "reply" }>;
    },
  };
  return app;
}

export async function readyApp() {
  const app = await appOnSocket();
  app.say(welcomeHello);
  await app.hearing("welcome");
  const before = ready;
  app.say({ type: "ready" });
  await vi.waitFor(() => expect(ready).toBe(before + 1));
  return app;
}

export const calls = (made: Partial<CoreCalls>) => made as unknown as CoreCalls;
export const action = {
  kind: "action",
  action: "test.act",
  input: {},
} as const;

// Each test has its own folder, and what it opened goes with it.
export function useLink() {
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "sanctum-link-"));
    socketPath = join(folder, "test.link", "core.sock");
    gone = [];
    ready = 0;
    logs.length = 0;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    await link.close();
    await rm(folder, { recursive: true, force: true });
  });
}
