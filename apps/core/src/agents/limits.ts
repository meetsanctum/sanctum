import type { ActivityAuthor, NewActivityEntry } from "../activity/activity.js";

// How much AI agents may ask of the home: requests a minute and calls at
// once, and the device commands they send a minute, those an app's action
// sends for them included, for each agent and for the whole home together,
// so one agent left in a loop, or several at once, can't crowd out the
// household. Reads count too. A request over a limit is refused before
// anything runs, and a command over one before it goes to the device.

export type AgentLimits = {
  /** Requests in any minute, each agent's. */
  agentPerMinute: number;
  /** Requests in any minute, every agent's together. */
  homePerMinute: number;
  /** Calls under way at once, each agent's. */
  agentAtOnce: number;
  /** Calls under way at once, every agent's together. */
  homeAtOnce: number;
};

export const agentLimits: AgentLimits = {
  agentPerMinute: 120,
  homePerMinute: 300,
  agentAtOnce: 4,
  homeAtOnce: 8,
};

export type AgentCommandLimits = {
  /** Device commands in any minute, each agent's. */
  agentPerMinute: number;
  /** Device commands in any minute, every agent's together. */
  homePerMinute: number;
};

// Enough for turning off every light of a large home at once, and a few
// rooms more, but not for a loop that keeps switching them.
const agentCommandLimits: AgentCommandLimits = {
  agentPerMinute: 120,
  homePerMinute: 240,
};

const minuteMs = 60_000;

export type LimitRefusal = {
  limited: "per_minute" | "at_once" | "commands";
  retryAfter: number;
};

// Counts in the last minute, each agent's and the home's: an agent's
// next one waits until both have room, the later of the two.
function minuteWindows(
  limits: { agentPerMinute: number; homePerMinute: number },
  now: () => number,
) {
  // Each agent's in the last minute, oldest first, and the home's.
  const recent = new Map<string, number[]>();
  const home: number[] = [];

  const prune = (times: number[], at: number) => {
    while (times.length && times[0]! <= at - minuteMs) times.shift();
  };

  /** Counts one, or answers how many seconds until there's room. */
  return function take(
    agentId: string,
    shouldCount = true,
  ): number | undefined {
    const at = now();
    for (const [id, times] of recent) {
      if (times.at(-1)! > at - minuteMs) break;
      recent.delete(id);
    }
    const times = recent.get(agentId) ?? [];
    prune(times, at);
    prune(home, at);
    const agentWait =
      times.length >= limits.agentPerMinute ? times[0]! + minuteMs - at : 0;
    const homeWait =
      home.length >= limits.homePerMinute ? home[0]! + minuteMs - at : 0;
    const wait = Math.max(agentWait, homeWait);
    if (wait > 0) return Math.ceil(wait / 1_000);
    if (!shouldCount) return;
    times.push(at);
    // Keep agents in order of their latest, so idle ones expire.
    recent.delete(agentId);
    recent.set(agentId, times);
    home.push(at);
  };
}

export function createAgentLimiter(
  limits: AgentLimits = agentLimits,
  now: () => number = () => performance.now(),
) {
  const take = minuteWindows(limits, now);
  const underWay = new Map<string, number>();
  let homeUnderWay = 0;

  return {
    /** Counts a request before the body is read. */
    takeRequest(agentId: string): LimitRefusal | undefined {
      const retryAfter = take(agentId);
      if (retryAfter !== undefined) {
        return { limited: "per_minute", retryAfter };
      }
    },

    /** Holds a slot while a request is being handled. */
    begin(agentId: string): { done: () => void } | LimitRefusal {
      const running = underWay.get(agentId) ?? 0;
      if (running >= limits.agentAtOnce || homeUnderWay >= limits.homeAtOnce) {
        return { limited: "at_once", retryAfter: 1 };
      }
      underWay.set(agentId, running + 1);
      homeUnderWay += 1;
      let finished = false;
      return {
        done() {
          if (finished) return;
          finished = true;
          const left = (underWay.get(agentId) ?? 1) - 1;
          if (left > 0) underWay.set(agentId, left);
          else underWay.delete(agentId);
          homeUnderWay -= 1;
        },
      };
    },
  };
}

export type AgentLimiter = ReturnType<typeof createAgentLimiter>;

/** Device commands a minute, counted as each goes to its device. */
export function createAgentCommandLimiter(
  limits: AgentCommandLimits = agentCommandLimits,
  now: () => number = () => performance.now(),
) {
  const take = minuteWindows(limits, now);
  return {
    takeCommand(agentId: string, shouldCount = true): LimitRefusal | undefined {
      const retryAfter = take(agentId, shouldCount);
      if (retryAfter !== undefined) return { limited: "commands", retryAfter };
    },
  };
}

/**
 * Logs an agent held back by a limit, at most once a minute for each agent
 * and limit, so an agent in a loop doesn't fill the activity log, and each
 * limit it reaches is named. The endpoint's limits and the device commands'
 * share one.
 */
export function createLimitedLog(options: {
  record: (entry: NewActivityEntry) => string;
  agentWho: (id: string) => ActivityAuthor;
  now?: () => number;
}) {
  const now = options.now ?? (() => performance.now());
  const lastLogged = new Map<string, number>();
  return function logLimited(
    agentId: string,
    limited: LimitRefusal["limited"],
  ) {
    const at = now();
    for (const [key, last] of lastLogged) {
      if (at - last < minuteMs) break;
      lastLogged.delete(key);
    }
    const key = `${agentId} ${limited}`;
    if (lastLogged.has(key)) return;
    lastLogged.set(key, at);
    options.record({
      action: "agents.limited",
      outcome: "refused",
      reason: limited,
      ...options.agentWho(agentId),
    });
  };
}

export type LimitedLog = ReturnType<typeof createLimitedLog>;
