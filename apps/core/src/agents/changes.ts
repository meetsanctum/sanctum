import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";

import type { CommandChange } from "../devices/devices.js";
import type { AgentCaller } from "../app-host/gate.js";

// What an AI agent changed, so it can put it back: for each light or switch
// a call of `lights` or `device_command` sent a command, the fields it asked
// for and how the capability was before. Kept in memory, for each agent its
// last five changes for an hour (per device for Assistant requests), and
// dropped once the agent is removed. A change put back keeps its answer, so
// putting it back again says the same.

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
  type Scope = Pick<AgentCaller, "id" | "requestClientId">;
  const byScope = new Map<
    string,
    { agent: string; changes: AgentChange[]; moodAt?: Date }
  >();
  const keyOf = ({ id, requestClientId }: Scope) =>
    JSON.stringify([id, requestClientId]);

  // Drops what has run out, and the changes of agents that were removed.
  function prune() {
    const oldest = now().getTime() - changesKept.ms;
    for (const [key, scope] of byScope) {
      const { agent, changes, moodAt } = scope;
      const kept = changes.filter((change) => change.at.getTime() > oldest);
      if (moodAt && moodAt.getTime() <= oldest) delete scope.moodAt;
      if (
        (kept.length === 0 && !scope.moodAt) ||
        !options.isActiveAgent(agent)
      ) {
        byScope.delete(key);
      } else {
        scope.changes = kept;
      }
    }
  }

  return {
    /** Keeps a change, answering its id; none when nothing was sent. */
    record(agent: Scope, changed: readonly ChangedCapability[]) {
      prune();
      if (changed.length === 0 || !options.isActiveAgent(agent.id)) return null;
      const change: AgentChange = { id: randomUUID(), at: now(), changed };
      const key = keyOf(agent);
      const changes = [...(byScope.get(key)?.changes ?? []), change];
      byScope.set(key, {
        agent: agent.id,
        changes: changes.slice(-changesKept.count),
      });
      return change.id;
    },

    /** Stops a request from implicitly undoing a change before a mood. */
    recordMood(agent: Scope) {
      prune();
      if (!options.isActiveAgent(agent.id)) return;
      const key = keyOf(agent);
      byScope.set(key, {
        agent: agent.id,
        changes: byScope.get(key)?.changes ?? [],
        moodAt: now(),
      });
    },

    /** The agent's last change that's still kept, or a mood run. */
    last(agent: Scope): AgentChange | "mood" | undefined {
      prune();
      const scope = byScope.get(keyOf(agent));
      return scope?.moodAt ? "mood" : scope?.changes.at(-1);
    },

    /** One of the agent's own changes that's still kept. */
    find(agent: Scope, id: string): AgentChange | undefined {
      prune();
      return byScope
        .get(keyOf(agent))
        ?.changes.find((change) => change.id === id);
    },
  };
}

export type AgentChanges = ReturnType<typeof createAgentChanges>;
