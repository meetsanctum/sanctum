import { aiAssistantPermission } from "@meetsanctum/app-sdk";
import { randomUUID } from "node:crypto";

import type { Activity } from "../activity/activity.js";
import type { ActivityViews } from "../activity/views.js";
import { ActionCallError } from "../app-host/errors.js";
import type { AppHost } from "../app-host/host.js";
import type { Auth } from "../auth/auth.js";
import type { CoreDatabase } from "../database.js";
import type { Devices } from "../devices/devices.js";
import type { Lights } from "../devices/lights.js";
import type { Entities } from "../entities/entities.js";
import type { History } from "../history/history.js";
import type { PlacesModule } from "../places/places.js";
import {
  assistantOf,
  createAssistantCalls,
  type TurnOpener,
} from "./assistants.js";
import { createAgentsCanUse } from "./can-use.js";
import { createAgentChanges } from "./changes.js";
import { createCoreTools } from "./core-tools.js";
import {
  createAgentCommandLimiter,
  createAgentLimiter,
  createLimitedLog,
  type AgentCommandLimits,
} from "./limits.js";
import { createAgentTools, type AgentTools } from "./tools.js";

export function createAgentAccess(
  db: CoreDatabase,
  options: {
    activity: Activity;
    auth: Auth;
    apps: () => AppHost;
    tools: () => AgentTools;
    commandLimits?: AgentCommandLimits;
    now?: () => Date;
  },
) {
  const { activity, auth, apps, now } = options;
  const record = activity.for("agents");
  const canUse = createAgentsCanUse(db, {
    record,
    apps: () => apps().offers(),
    now,
  });
  const ticks = now && (() => now().getTime());
  // Assistant apps have a separate home pool from MCP clients.
  const mcpCommands = createAgentCommandLimiter(options.commandLimits, ticks);
  const assistantCommands = createAgentCommandLimiter(
    options.commandLimits,
    ticks,
  );
  const logLimited = createLimitedLog({
    record,
    agentWho: activity.agentWho,
    now: ticks,
  });

  function canActFor(who: TurnOpener) {
    return auth.clients.canAddAgent({
      kind: who.kind === "user" ? "person" : "client",
      id: who.id,
    });
  }

  function canUseAssistant(
    assistant: NonNullable<ReturnType<typeof assistantOf>>,
  ) {
    return (
      (apps().holds(assistant.appId)?.granted.includes(aiAssistantPermission) ??
        false) &&
      canActFor(assistant.who)
    );
  }

  activity.nameClients({
    name: (id) => {
      const assistant = assistantOf(id);
      return assistant
        ? (apps().manifest(assistant.appId)?.name ?? null)
        : auth.clients.name(id);
    },
    agentAdder: (id) => {
      const assistant = assistantOf(id);
      if (!assistant) return auth.agentAdder(id);
      const { who } = assistant;
      return auth.named({
        kind: who.kind === "user" ? "person" : "client",
        id: who.id,
      });
    },
  });

  return {
    canUse,
    logLimited,
    // Temporary stops leave an assistant's changes available once it resumes.
    isRetained(id: string) {
      const assistant = assistantOf(id);
      return assistant
        ? canUseAssistant(assistant)
        : auth.clients.isActiveAgent(id);
    },
    isActive(id: string) {
      const assistant = assistantOf(id);
      return assistant
        ? apps().isRunning(assistant.appId) && canUseAssistant(assistant)
        : auth.clients.isActiveAgent(id);
    },
    checkAgentCommand(id: string, shouldCount = true) {
      const limiter = assistantOf(id) ? assistantCommands : mcpCommands;
      const refusal = limiter.takeCommand(id, shouldCount);
      if (!refusal) return;
      logLimited(id, refusal.limited);
      throw new ActionCallError("limited");
    },
    assistant: createAssistantCalls({
      tools: options.tools,
      appName: (appId) => apps().manifest(appId)?.name,
      canActFor,
      limiter: createAgentLimiter(undefined, ticks),
      logLimited,
      duringCall: (callId, work) => activity.duringCall(callId, work),
      newCallId: randomUUID,
    }),
  };
}

/** The tools shared by MCP clients and assistant apps. */
export function assembleAgentTools(
  { canUse, isRetained }: ReturnType<typeof createAgentAccess>,
  options: {
    apps: AppHost;
    places: PlacesModule;
    devices: Devices;
    lights: Lights;
    entities: Entities;
    activity: Activity;
    activityViews: ActivityViews;
    history: History;
    now?: () => Date;
  },
) {
  const {
    apps,
    places,
    devices,
    lights,
    entities,
    activity,
    activityViews,
    history,
    now,
  } = options;
  const readableDeviceKinds = () => canUse.readableDeviceKinds();
  const appName = (appId: string) => apps.manifest(appId)?.name;
  return createAgentTools({
    canUse: () => canUse.list(),
    core: createCoreTools({
      readableDeviceKinds,
      appName,
      devices,
      lights,
      changes: createAgentChanges({ isActiveAgent: isRetained, now }),
      entities,
      activity,
      activityViews,
      history,
      now,
      record: activity.for("agents"),
      agentWho: activity.agentWho,
    }),
    readableDeviceKinds,
    places: () => places.list(),
    devices,
    apps: { name: appName, action: apps.action, call: apps.call },
  });
}
