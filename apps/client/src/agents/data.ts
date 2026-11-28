import type { AiCanUse } from "@meetsanctum/app-sdk";
import type { AgentInfo } from "@meetsanctum/auth-protocol";
import type { LiveFeed } from "@meetsanctum/ui-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { coreJson } from "../core-fetch";
import { problemReason } from "../device-parts";
import { everyWhileShown } from "../while-shown";

// What Settings reads of AI agents: the agents themselves, and what they can
// use, which every client may change. The agents page asks for the agents
// every few seconds, so a new one shows and last-seen times move on; other
// pages ask again on the shell's refresh.

const agentsEvery = 5_000;
const requestTimeoutMs = 10_000;

/**
 * The home's AI agents, once the core has said: asked for every few seconds,
 * or on the shell's refresh when given its live feed.
 */
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
    const stopPolling = live ? undefined : everyWhileShown(agentsEvery, update);
    return () => {
      latestAnswer.current = ++request.current;
      stop?.();
      stopPolling?.();
    };
  }, [live, refresh]);
  return { agents, refresh };
}

/** What AI agents can use, once the core has said, and the answer to a change. */
export function useAiCanUse(live: LiveFeed) {
  const [canUse, setCanUse] = useState<AiCanUse>();
  // Why the last read failed, until one succeeds.
  const [problem, setProblem] = useState<string>();
  const request = useRef(0);
  const refresh = useCallback(async ({ clear = false } = {}) => {
    const current = ++request.current;
    if (clear) {
      setCanUse(undefined);
      setProblem(undefined);
    }
    try {
      const next = await coreJson<AiCanUse>("/api/agents/can-use", {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (current !== request.current) return;
      setCanUse(next);
      setProblem(undefined);
    } catch (error) {
      if (current === request.current) setProblem(problemReason(error));
    }
  }, []);
  const acceptChange = (next: AiCanUse) => {
    // An earlier read can still be in flight when a change comes back.
    request.current++;
    setCanUse(next);
    setProblem(undefined);
  };
  useEffect(() => {
    void refresh();
    const stop = live.subscribe({ refresh: () => void refresh() });
    return () => {
      request.current++;
      stop();
    };
  }, [live, refresh]);
  return {
    canUse,
    acceptChange,
    hasFailed: problem !== undefined,
    problem,
    refresh,
  };
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
