import type {
  AiToolAnswer,
  EarlierExchange,
  EarlierToolCall,
} from "@meetsanctum/app-sdk";

// The 5-minute window: each device's recent requests to the Assistant, so
// "and the dining room too" or "put it back" has something to go on. Kept in
// memory only, for the device it came from: never written down, never shown
// to another device, an action's turn, an AI agent or the activity log. Each
// exchange is recorded as it happens, so one cut off by a newer request still
// says what it had done.

export const windowLimits = {
  /** How long after a device's last request its window is kept. */
  ms: 5 * 60_000,
  /** How many earlier exchanges a request gets. */
  exchanges: 6,
  /** How large they may be together, as JSON. */
  bytes: 32 * 1024,
  /** A tool's answer larger than this is kept as a stub. */
  answerBytes: 4 * 1024,
};

type KeptTool = {
  name: string;
  input: Record<string, unknown>;
  answer?: AiToolAnswer | { tooLong: true; isError: boolean };
};

/** One request's exchange, as it happens. */
export type Exchange = {
  asked: string;
  at: Date;
  tools: KeptTool[];
  reply: string | null;
  cutOff: boolean;
};

type Window = {
  // The Assistant's run it belongs to: a pause, restart or removal starts
  // the window afresh.
  runId: number;
  exchanges: Exchange[];
  timer: NodeJS.Timeout;
};

const refused: AiToolAnswer = { text: "The call was refused.", isError: true };

function toolShown(tool: KeptTool): EarlierToolCall {
  const { name, input, answer } = tool;
  if (!answer) return { name, input, outcome: "unknown" };
  if ("tooLong" in answer) {
    return { name, input, outcome: "too_long", isError: answer.isError };
  }
  return { name, input, outcome: "answered", ...answer };
}

function shown(exchange: Exchange): EarlierExchange {
  return {
    asked: exchange.asked,
    at: exchange.at.toISOString(),
    tools: exchange.tools.map(toolShown),
    reply: exchange.reply,
    cutOff: exchange.cutOff,
  };
}

const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export function createRequestWindows(options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const windows = new Map<string, Window>();

  function drop(device: string) {
    const window = windows.get(device);
    if (!window) return;
    clearTimeout(window.timer);
    windows.delete(device);
  }

  function expiring(device: string) {
    const timer = setTimeout(() => drop(device), windowLimits.ms);
    timer.unref();
    return timer;
  }

  return {
    /**
     * Starts a device's exchange for its new request, and answers what came
     * before it: the last 6, oldest first, within 32 KB.
     */
    begin(device: string, runId: number, asked: string) {
      let window = windows.get(device);
      if (window?.runId !== runId) {
        drop(device);
        window = undefined;
      }
      const earlier = (window?.exchanges ?? [])
        .slice(-windowLimits.exchanges)
        .map(shown);
      let size = sizeOf(earlier);
      while (earlier.length > 0 && size > windowLimits.bytes) {
        size -= sizeOf(earlier.shift()) + 1;
      }
      const exchange: Exchange = {
        asked,
        at: now(),
        tools: [],
        reply: null,
        cutOff: false,
      };
      if (window) {
        clearTimeout(window.timer);
        window.timer = expiring(device);
        window.exchanges = [
          ...window.exchanges.slice(-windowLimits.exchanges + 1),
          exchange,
        ];
      } else {
        windows.set(device, {
          runId,
          exchanges: [exchange],
          timer: expiring(device),
        });
      }
      return { exchange, earlier };
    },

    /** Keeps a tool call as it starts; its answer goes in as it returns. */
    tool(exchange: Exchange, name: string, input: Record<string, unknown>) {
      const kept: KeptTool = { name, input };
      exchange.tools.push(kept);
      return (answer: AiToolAnswer | null) => {
        const given = answer ?? refused;
        kept.answer =
          Buffer.byteLength(given.text) > windowLimits.answerBytes
            ? { tooLong: true, isError: given.isError }
            : given;
      };
    },

    /** Drops every window: the Assistant stopped, or the core is stopping. */
    clear() {
      for (const device of [...windows.keys()]) drop(device);
    },
  };
}

export type RequestWindows = ReturnType<typeof createRequestWindows>;
