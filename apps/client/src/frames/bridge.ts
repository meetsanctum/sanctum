import {
  frameBridge,
  isFrameHello,
  type AppClient,
  type CapabilityCommand,
  type FrameBarAction,
  type FramePort,
  type PageParams,
  type ToFrame,
} from "@meetsanctum/ui-sdk";

// The shell's end of an app's page in its frame. It waits for the hello of
// that frame's window, and only that one, with the one-time code the shell
// put in the frame's address, and answers it with one end of a message
// channel. From then on everything goes over that port. The frame's code is
// the app's, so nothing it sends is believed until checked: it asks only
// for AppClient's operations by name, each run through the shell's client
// for that app, which limits it to what the app may do, and at most so many
// at once.

/** What the frame tells the shell, once checked. */
export type FrameEvent =
  | { type: "ready" }
  | { type: "failed"; reason: "files" | "stopped" }
  | {
      type: "bar";
      title: string;
      actions: FrameBarAction[];
      revision: number;
    }
  | { type: "open"; page: string; params: PageParams }
  | { type: "back" }
  | { type: "openSettings" };

export type FrameBridge = {
  send(message: ToFrame): void;
  /** Its live updates through the app's client now, as its grants change. */
  renew(): void;
  close(): void;
};

// Requests a frame may have waiting at once; more are refused, not queued.
export const requestsAllowed = 32;
// A bar title or page name longer than this isn't one.
const longestText = 200;

export function openBridge(options: {
  /** The frame's window, which alone may say hello. */
  frame: () => Window | null;
  code: string;
  client: () => AppClient;
  /** What the frame is told first, once it has its port. */
  setup: () => Extract<ToFrame, { type: "setup" }>;
  on: (event: FrameEvent) => void;
  /** Where the shell listens for the hello, the window it shows the frame in. */
  host?: Window;
}): FrameBridge {
  const { frame, code, client, setup, on, host = window } = options;
  let port: MessagePort | undefined;
  let unsubscribe: (() => void) | undefined;
  let waiting = 0;
  let isAsking = false;
  let isClosed = false;

  const send = (message: ToFrame) => {
    port?.postMessage(message);
  };

  const hello = (event: MessageEvent) => {
    const from = frame();
    if (!from || event.source !== from || !isFrameHello(event.data)) return;
    if (event.data.code !== code) return;
    host.removeEventListener("message", hello);
    if (event.data.bridge !== frameBridge) {
      return on({ type: "failed", reason: "files" });
    }
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (message) => receive(message.data);
    const answer: FramePort = { sanctum: "port", bridge: frameBridge };
    // A sandboxed frame's origin is opaque, so it can't be named; the
    // message goes to that window alone.
    from.postMessage(answer, "*", [channel.port2]);
    send(setup());
  };
  host.addEventListener("message", hello);

  function receive(data: unknown) {
    if (isClosed || typeof data !== "object" || data === null) return;
    const message = data as Partial<Record<string, unknown>> & {
      type?: unknown;
    };
    switch (message.type) {
      case "request":
        return request(message);
      case "subscribe":
        return live(message.on === true);
      case "bar": {
        const { title, revision } = message;
        const actions = barActionsOf(message.actions);
        if (isText(title) && actions && isRevision(revision)) {
          on({ type: "bar", title, actions, revision });
        }
        return;
      }
      case "open":
        if (isText(message.page) && isParams(message.params)) {
          on({ type: "open", page: message.page, params: message.params });
        }
        return;
      case "back":
      case "openSettings":
      case "ready":
        return on({ type: message.type });
      case "failed":
        return on({
          type: "failed",
          reason: message.reason === "stopped" ? "stopped" : "files",
        });
    }
  }

  function request(message: Partial<Record<string, unknown>>) {
    const { id } = message;
    if (typeof id !== "number" || !Number.isInteger(id)) return;
    const operation = operationOf(client(), message);
    if (!operation) {
      return send(refusal(id, "That isn't something a page can ask for"));
    }
    if (waiting >= requestsAllowed) {
      return send(refusal(id, "Too much asked at once", "busy"));
    }
    // The household is asked one thing at a time.
    const isAsk = message.op === "ask";
    if (isAsk && isAsking) {
      return send(refusal(id, "Already asking", "busy"));
    }
    waiting++;
    if (isAsk) isAsking = true;
    const done = () => {
      waiting--;
      if (isAsk) isAsking = false;
    };
    operation().then(
      (value) => {
        done();
        if (!isClosed) send({ type: "answer", id, ok: true, value });
      },
      (error: unknown) => {
        done();
        if (isClosed) return;
        const { message: said = String(error), code } = (error ?? {}) as {
          message?: string;
          code?: unknown;
        };
        send(refusal(id, said, typeof code === "string" ? code : undefined));
      },
    );
  }

  function live(on: boolean) {
    if (on && !unsubscribe) {
      unsubscribe = client().subscribe({
        message: (message) => send({ type: "live", message }),
        refresh: () => send({ type: "refresh" }),
      });
    } else if (!on && unsubscribe) {
      unsubscribe();
      unsubscribe = undefined;
    }
  }

  return {
    send,
    renew() {
      if (!unsubscribe) return;
      live(false);
      live(true);
    },
    close() {
      isClosed = true;
      host.removeEventListener("message", hello);
      unsubscribe?.();
      unsubscribe = undefined;
      port?.close();
    },
  };
}

// The operation a request names, run through the app's client, or none for
// what isn't one.
function operationOf(
  client: AppClient,
  message: Partial<Record<string, unknown>>,
): (() => Promise<unknown>) | undefined {
  switch (message.op) {
    case "call": {
      const { actionId, input } = message;
      return isText(actionId) ? () => client.call(actionId, input) : undefined;
    }
    case "places":
      return () => client.places();
    case "devices":
      return () => client.devices();
    case "command":
      // The core checks the command itself, and what the app may command.
      return typeof message.command === "object" && message.command !== null
        ? () => client.command(message.command as CapabilityCommand)
        : undefined;
    case "entities":
      return () => client.entities();
    case "settings":
      return () => client.settings();
    case "ask": {
      const { permissions } = message;
      return Array.isArray(permissions) &&
        permissions.length > 0 &&
        permissions.every(isText)
        ? () => client.ask(permissions)
        : undefined;
    }
  }
  return undefined;
}

const refusal = (
  id: number,
  message: string,
  code?: string,
): Extract<ToFrame, { type: "answer" }> => ({
  type: "answer",
  id,
  ok: false,
  error: code ? { message, code } : { message },
});

// The top bar's actions as a page describes them: at most three, the
// primary one at most, each a word to draw; anything else is none.
function barActionsOf(value: unknown): FrameBarAction[] | undefined {
  if (!Array.isArray(value) || value.length > 3) return undefined;
  const actions: FrameBarAction[] = [];
  for (const each of value as Partial<Record<string, unknown>>[]) {
    if (typeof each !== "object" || each === null) return undefined;
    const { id, label, primary, disabled } = each;
    if (!isText(id) || !isText(label) || label.length > 40) return undefined;
    actions.push({
      id,
      label,
      ...(primary === true ? { primary: true } : {}),
      ...(disabled === true ? { disabled: true } : {}),
    });
  }
  const ids = new Set(actions.map((action) => action.id));
  const primaries = actions.filter((action) => action.primary).length;
  return ids.size === actions.length && primaries <= 1 ? actions : undefined;
}

const isRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= longestText;

function isParams(value: unknown): value is PageParams {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (each) => typeof each === "string" && each.length <= longestText,
    )
  );
}
