import {
  appManifestSchema,
  type AiCanUse,
  type AiOfferInfo,
  type CapabilityKind,
  type Places,
} from "@meetsanctum/app-sdk";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";

import type { DeclaredAction } from "../app-host/contract.js";
import { ActionCallError } from "../app-host/errors.js";
import type { AgentCaller, Caller } from "../app-host/gate.js";
import type { Devices } from "../devices/devices.js";
import { answer, errorAnswer, notInstructions, toolError } from "./answers.js";
import type { CoreTools } from "./core-tools.js";
import {
  blockedNeeds,
  notAllowedOf,
  notForAgents,
  overviewDevice,
  settingsOf,
  type HomeOverview,
} from "./overview.js";

// The tools an AI agent sees, fresh from what AI agents can use on every
// listing: `home_overview`, always, the core's own while what each needs is
// on (core-tools.ts), and one for each of an app's actions that's offered and
// on, with everything it needs on. Every call is checked against that list
// again, then by the same gate as a client's: an action switched off since
// the agent listed its tools is refused. One offered but
// off answers `not_allowed` with where it's decided; one never offered
// answers as an unknown tool does, so its existence doesn't leak.

type AgentToolsOptions = {
  canUse: () => AiCanUse;
  /** The core's own tools (core-tools.ts). */
  core: CoreTools;
  readableDeviceKinds: () => ReadonlySet<CapabilityKind>;
  places: () => Places;
  devices: Pick<Devices, "list">;
  apps: {
    /** An installed app's name. */
    name: (appId: string) => string | undefined;
    action: (appId: string, actionId: string) => DeclaredAction | undefined;
    call: (request: {
      principal: Caller;
      appId: string;
      actionId: string;
      input: unknown;
    }) => Promise<unknown>;
  };
};

const overviewTool: Tool = {
  name: "home_overview",
  title: "Home overview",
  description: [
    "The home's floors, rooms and zones, the devices you may see with what they're doing now, your own name, and what you can't use, with where a person decides it.",
    "Match the person's words against these names, and ask which room when they name none or two match. Never act on the whole home unless the person said so.",
    "Tell the person what's switched off and where it's decided, rather than trying another way.",
    notInstructions,
  ].join(" "),
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
};

// Short names belong to actions in the app's own namespace, such as
// moods.runMood. A separate namespace keeps its full id after a double
// underscore, so installing an app or adding an action can't rename a tool.
function namedActions(offers: readonly AiOfferInfo[]) {
  const actions = new Map<string, AiOfferInfo>();
  for (const offer of offers) {
    if (offer.kind !== "action") continue;
    if (!appManifestSchema.shape.id.safeParse(offer.app).success) continue;
    if (!/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(offer.id)) continue;

    const namespace = offer.app
      .slice(offer.app.lastIndexOf(".") + 1)
      .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const app = offer.app.replaceAll(".", "_");
    const [prefix, action, nested] = offer.id.split(".");
    const name =
      prefix === namespace && nested === undefined
        ? `${app}_${action}`
        : `${app}__${offer.id.replaceAll(".", "_")}`;
    actions.set(name, offer);
  }
  return actions;
}

const isUsable = (offer: AiOfferInfo) => offer.on && offer.missing.length === 0;

// Why an offered item can't be used, and where that's decided: the app's
// settings for its own switch and its other offers, What AI agents can use
// for the core's areas.
function notAllowed(canUse: AiCanUse, offer: AiOfferInfo, appName: string) {
  const where = settingsOf(appName);
  if (!offer.on) {
    return toolError(
      "not_allowed",
      `“${offer.title}” is switched off for AI agents in ${where}.`,
    );
  }
  const blocked = blockedNeeds(canUse, offer, where);
  if (blocked.length === 0) {
    return toolError(
      "not_allowed",
      `“${offer.title}” has requirements that aren't available for AI agents in ${where}.`,
    );
  }
  const needs = blocked.map(({ title }) => `“${title}”`).join(" and ");
  const wheres = new Set(blocked.map((need) => need.where));
  const are = blocked.length > 1 ? "are" : "is";
  return toolError(
    "not_allowed",
    `“${offer.title}” needs ${needs}, which ${are} switched off for AI agents in ${[...wheres].join(" and ")}.`,
  );
}

export function createAgentTools(options: AgentToolsOptions) {
  const { apps } = options;

  function inputSchemaOf(offer: AiOfferInfo): Tool["inputSchema"] | undefined {
    const schema = apps.action(offer.app, offer.id)?.schema;
    if (!schema) return undefined;
    if (schema.type === "object") return { ...schema, type: "object" };
    // The manifest can describe several object shapes with a union. MCP
    // also requires an explicit object type on the schema's root.
    const variants = schema.oneOf ?? schema.anyOf;
    if (
      schema.type === undefined &&
      Array.isArray(variants) &&
      variants.length > 0 &&
      variants.every((variant) => variant?.type === "object")
    ) {
      return { ...schema, type: "object" };
    }
  }

  function overview(agent: AgentCaller): HomeOverview {
    const places = options.places();
    const kinds = options.readableDeviceKinds();
    return {
      agent: { name: agent.name },
      home: places.home,
      floors: places.floors,
      rooms: places.rooms,
      zones: places.zones,
      devices: options.devices.list({ kinds }).map(overviewDevice),
      notAllowed: notAllowedOf(options.canUse(), apps.name),
      notForAgents,
    };
  }

  return {
    list(): Tool[] {
      const canUse = options.canUse();
      const tools = [overviewTool];
      tools.push(...options.core.list(canUse));
      for (const [name, offer] of namedActions(canUse.offers)) {
        if (!isUsable(offer)) continue;
        const inputSchema = inputSchemaOf(offer);
        if (!inputSchema) continue;
        tools.push({
          name,
          title: offer.title,
          description: `${offer.description} ${notInstructions}`,
          inputSchema,
          // A write such as running a mood can turn lights off, so none
          // says it isn't destructive.
          annotations: offer.tier === "read" ? { readOnlyHint: true } : {},
        });
      }
      return tools;
    },

    /**
     * Runs one tool for an agent. Undefined for a tool that isn't there,
     * which the endpoint answers as the protocol's unknown tool.
     */
    async call(
      agent: AgentCaller,
      name: string,
      input: Record<string, unknown> | undefined,
    ): Promise<CallToolResult | undefined> {
      if (name === overviewTool.name) {
        return input !== undefined && Object.keys(input).length > 0
          ? toolError("invalid_input", "The home overview takes no input.")
          : answer(overview(agent));
      }
      const canUse = options.canUse();
      const coreResult = await options.core.call(
        name,
        agent,
        input ?? {},
        canUse,
      );
      if (coreResult) return coreResult;
      const offer = namedActions(canUse.offers).get(name);
      if (!offer || !inputSchemaOf(offer)) return undefined;
      try {
        return answer(
          await apps.call({
            principal: agent,
            appId: offer.app,
            actionId: offer.id,
            input: input ?? {},
          }),
        );
      } catch (error) {
        // The app host refuses what's off, and logs it under the agent's
        // name; the agent hears where it's decided.
        if (!isUsable(offer)) {
          return notAllowed(canUse, offer, apps.name(offer.app) ?? offer.app);
        }
        // The app host may wait for an app to start and check access again.
        // Use the current switches if it refused the call after that wait.
        if (error instanceof ActionCallError && error.code === "forbidden") {
          const current = options.canUse();
          const latest = current.offers.find(
            (each) => each.app === offer.app && each.id === offer.id,
          );
          if (latest && !isUsable(latest)) {
            return notAllowed(
              current,
              latest,
              apps.name(offer.app) ?? offer.app,
            );
          }
        }
        return errorAnswer(error);
      }
    },
  };
}

export type AgentTools = ReturnType<typeof createAgentTools>;
