// How much AI agents may ask of the home: requests a minute and calls at
// once, for each agent and for the whole home together, so one agent left
// in a loop, or several at once, can't crowd out the household. Reads count
// too. A request over a limit is refused before anything runs.

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

const minuteMs = 60_000;

export type LimitRefusal = {
  limited: "per_minute" | "at_once";
  retryAfter: number;
};

export function createAgentLimiter(
  limits: AgentLimits = agentLimits,
  now: () => number = () => performance.now(),
) {
  // Each agent's requests in the last minute, oldest first, and the home's.
  const recent = new Map<string, number[]>();
  const home: number[] = [];
  const underWay = new Map<string, number>();
  let homeUnderWay = 0;

  const prune = (times: number[], at: number) => {
    while (times.length && times[0]! <= at - minuteMs) times.shift();
  };

  return {
    /** Counts a request before the body is read. */
    takeRequest(agentId: string): LimitRefusal | undefined {
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
      if (wait > 0) {
        return { limited: "per_minute", retryAfter: Math.ceil(wait / 1_000) };
      }
      times.push(at);
      // Keep agents in order of their latest request, so idle ones expire.
      recent.delete(agentId);
      recent.set(agentId, times);
      home.push(at);
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
