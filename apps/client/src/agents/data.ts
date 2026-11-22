import type { AiCanUse } from "@meetsanctum/app-sdk";
import type { AgentInfo } from "@meetsanctum/auth-protocol";
import { useCallback, useEffect, useState } from "react";

import { coreJson } from "../core-fetch";

// What Settings reads of AI agents: the agents themselves, which it asks
// for again every few seconds so a new one shows and last-seen times move
// on, and what they can use, which only Settings changes.

const agentsEvery = 5_000;

/** The home's AI agents, once the core has said, asking again now and then. */
export function useAgents() {
  const [agents, setAgents] = useState<AgentInfo[]>();
  const refresh = useCallback(async () => {
    setAgents(await coreJson<AgentInfo[]>("/api/auth/agents"));
  }, []);
  useEffect(() => {
    let stopped = false;
    const update = () =>
      void coreJson<AgentInfo[]>("/api/auth/agents").then(
        (next) => {
          if (!stopped) setAgents(next);
        },
        // The next turn asks again.
        () => undefined,
      );
    update();
    const timer = window.setInterval(update, agentsEvery);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);
  return { agents, refresh };
}

/** What AI agents can use, once the core has said, and the answer to a change. */
export function useAiCanUse() {
  const [canUse, setCanUse] = useState<AiCanUse>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let stopped = false;
    coreJson<AiCanUse>("/api/agents/can-use").then(
      (next) => {
        if (!stopped) setCanUse(next);
      },
      () => {
        if (!stopped) setFailed(true);
      },
    );
    return () => {
      stopped = true;
    };
  }, []);
  return { canUse, setCanUse, failed };
}

/** Switches one of the core's areas, answered with what AI agents can use now. */
export const switchArea = (id: string, on: boolean) =>
  coreJson<AiCanUse>("/api/agents/can-use/area", {
    method: "POST",
    json: { id, on },
  });

/** Switches one of an app's offers, answered with what AI agents can use now. */
export const switchOffer = (app: string, id: string, on: boolean) =>
  coreJson<AiCanUse>("/api/agents/can-use/offer", {
    method: "POST",
    json: { app, id, on },
  });
