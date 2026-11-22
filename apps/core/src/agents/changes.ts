import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";

import type { CommandChange } from "../devices/devices.js";

// What an AI agent changed, so it can put it back: for each light or switch
// a call of `lights` or `device_command` sent a command, the fields it asked
// for and how the capability was before. Kept in memory, for each agent its
// last five changes for an hour, and dropped once the agent is removed. A
// change put back keeps its answer, so putting it back again says the same.

/** How many of an agent's changes are kept, and for how long. */
export const changesKept = { count: 5, ms: 60 * 60_000 };

export type ChangedCapability = CommandChange & {
  device: string;
  capability: string;
  kind: "light" | "switch";
};

export type AgentChange = {
  id: string;
  at: Date;
  changed: readonly ChangedCapability[];
  // Shared by all calls putting back this change, including while it runs.
  restored?: Promise<CallToolResult>;
};

export function createAgentChanges(options: {
  isActiveAgent: (id: string) => boolean;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  const byAgent = new Map<string, AgentChange[]>();

  // Drops what has run out, and the changes of agents that were removed.
  function prune() {
    const oldest = now().getTime() - changesKept.ms;
    for (const [agent, changes] of byAgent) {
      const kept = changes.filter((change) => change.at.getTime() > oldest);
      if (kept.length === 0 || !options.isActiveAgent(agent)) {
        byAgent.delete(agent);
      } else {
        byAgent.set(agent, kept);
      }
    }
  }

  return {
    /** Keeps a change, answering its id; none when nothing was sent. */
    record(agent: string, changed: readonly ChangedCapability[]) {
      prune();
      if (changed.length === 0 || !options.isActiveAgent(agent)) return null;
      const change: AgentChange = { id: randomUUID(), at: now(), changed };
      const changes = [...(byAgent.get(agent) ?? []), change];
      byAgent.set(agent, changes.slice(-changesKept.count));
      return change.id;
    },

    /** One of the agent's own changes that's still kept. */
    find(agent: string, id: string): AgentChange | undefined {
      prune();
      return byAgent.get(agent)?.find((change) => change.id === id);
    },
  };
}

export type AgentChanges = ReturnType<typeof createAgentChanges>;
