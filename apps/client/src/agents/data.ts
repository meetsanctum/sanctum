import type { AiCanUse } from "@meetsanctum/app-sdk";
import type { AgentInfo } from "@meetsanctum/auth-protocol";
import type { LiveFeed } from "@meetsanctum/ui-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { coreJson } from "../core-fetch";

// What Settings reads of AI agents: the agents themselves, which it asks
// for again while a page is open, and the permissions everyone shares.

const agentsEvery = 5_000;
const requestTimeoutMs = 10_000;

/** Use the shell's refresh outside the agent list, which updates faster. */
export function useAgents(live?: LiveFeed) {
  const [agents, setAgents] = useState<AgentInfo[]>();
  const request = useRef(0);
  const latestAnswer = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    try {
      const next = await coreJson<AgentInfo[]>("/api/auth/agents", {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (current < latestAnswer.current) return;
      latestAnswer.current = current;
      setAgents(next);
    } catch {
      // The next refresh can ask again.
    }
  }, []);
  useEffect(() => {
    const update = () => void refresh();
    update();
    const stop = live?.subscribe({ refresh: update });
    const timer = live ? undefined : window.setInterval(update, agentsEvery);
    return () => {
      latestAnswer.current = ++request.current;
      stop?.();
      window.clearInterval(timer);
    };
  }, [live, refresh]);
  return { agents, refresh };
}

/** What AI agents can use, once the core has said, and the answer to a change. */
export function useAiCanUse(live: LiveFeed) {
  const [canUse, setCanUse] = useState<AiCanUse>();
  const [hasFailed, setHasFailed] = useState(false);
  const request = useRef(0);
  const refresh = useCallback(async ({ clear = false } = {}) => {
    const current = ++request.current;
    if (clear) {
      setCanUse(undefined);
      setHasFailed(false);
    }
    try {
      const next = await coreJson<AiCanUse>("/api/agents/can-use", {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (current !== request.current) return;
      setCanUse(next);
      setHasFailed(false);
    } catch {
      if (current === request.current) setHasFailed(true);
    }
  }, []);
  const acceptChange = (next: AiCanUse) => {
    // An earlier read can still be in flight when a change comes back.
    request.current++;
    setCanUse(next);
    setHasFailed(false);
  };
  useEffect(() => {
    void refresh();
    const stop = live.subscribe({ refresh: () => void refresh() });
    return () => {
      request.current++;
      stop();
    };
  }, [live, refresh]);
  return { canUse, acceptChange, hasFailed, refresh };
}

/** Switches one of the core's areas, answered with what AI agents can use now. */
export const switchArea = (id: string, on: boolean) =>
  coreJson<AiCanUse>("/api/agents/can-use/area", {
    method: "POST",
    signal: AbortSignal.timeout(requestTimeoutMs),
    json: { id, on },
  });

/** Switches one of an app's offers, answered with what AI agents can use now. */
export const switchOffer = (app: string, id: string, on: boolean) =>
  coreJson<AiCanUse>("/api/agents/can-use/offer", {
    method: "POST",
    signal: AbortSignal.timeout(requestTimeoutMs),
    json: { app, id, on },
  });
