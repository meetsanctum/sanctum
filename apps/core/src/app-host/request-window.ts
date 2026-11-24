import {
  earlierToolLimit,
  type AiToolAnswer,
  type EarlierExchange,
  type EarlierToolCall,
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
  bytes: number;
  answer?: AiToolAnswer | { tooLong: true; isError: boolean };
};

/** One request's exchange, as it happens. */
export type Exchange = {
  asked: string;
  at: Date;
  tools: KeptTool[];
  reply: string | null;
  cutOff: boolean;
  toolBytes: number;
  baseBytes: number;
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
        toolBytes: 0,
        baseBytes: 0,
      };
      // Leave room for the enclosing array and the longer cutOff value.
      exchange.baseBytes = sizeOf(shown(exchange)) + 2;
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
      const skip = () => {};
      if (exchange.tools.length >= earlierToolLimit) return skip;
      const room = windowLimits.bytes - exchange.baseBytes - exchange.toolBytes;
      let encoded: string;
      try {
        encoded = JSON.stringify({
          name,
          input,
          outcome: "too_long",
          isError: false,
        });
      } catch {
        // An input that cannot cross the socket cannot be replayed.
        return skip;
      }
      // Reserve space for the answer stub even while the call is still running.
      const bytes = Buffer.byteLength(encoded) + 1;
      if (bytes > room) return skip;
      const kept: KeptTool = {
        name,
        input: (JSON.parse(encoded) as EarlierToolCall).input,
        bytes,
      };
      exchange.toolBytes += bytes;
      exchange.tools.push(kept);
      return (answer: AiToolAnswer | null) => {
        if (!exchange.tools.includes(kept)) return;
        const { text, isError } = answer ?? refused;
        kept.answer = { tooLong: true, isError };
        if (Buffer.byteLength(text) > windowLimits.answerBytes) return;
        const answered = { ...kept, answer: { text, isError } };
        const answeredBytes = sizeOf(toolShown(answered)) + 1;
        const extra = answeredBytes - bytes;
        if (
          exchange.baseBytes + exchange.toolBytes + extra <=
          windowLimits.bytes
        ) {
          kept.answer = answered.answer;
          kept.bytes = answeredBytes;
          exchange.toolBytes += extra;
        }
      };
    },

    /** Keeps the reply, making room by dropping tool entries if needed. */
    reply(exchange: Exchange, text: string) {
      exchange.reply = text;
      exchange.baseBytes += sizeOf(text) - sizeOf(null);
      while (exchange.baseBytes + exchange.toolBytes > windowLimits.bytes) {
        const tool = exchange.tools.pop();
        if (!tool) break;
        exchange.toolBytes -= tool.bytes;
      }
    },

    /** Drops every window: the Assistant stopped, or the core is stopping. */
    clear() {
      for (const device of [...windows.keys()]) drop(device);
    },
  };
}

export type RequestWindows = ReturnType<typeof createRequestWindows>;
