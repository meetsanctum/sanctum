import {
  appManifestSchema,
  standardEntityTypes,
  type AiCanUse,
  type AiOfferInfo,
  type CapabilityKind,
  type EntityTypeDefinition,
  type Places,
} from "@meetsanctum/app-sdk";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { DeclaredAction } from "../app-host/contract.js";
import { ActionCallError } from "../app-host/errors.js";
import type { AgentCaller, Caller } from "../app-host/gate.js";
import type { Devices } from "../devices/devices.js";
import type { Entities } from "../entities/entities.js";
import {
  answer,
  errorAnswer,
  invalidInput,
  notInstructions,
  toolError,
} from "./answers.js";
import { inputSchemaOf } from "./core-tool.js";
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
// on (core-tools.ts), one for each of an app's actions that's offered and
// on, with everything it needs on, and `run` in place of those that run a
// standard type's entities, such as moods: it runs one by its app and key
// through that action, so an agent such as Sanctum's Assistant runs a mood
// without naming the app that keeps it or its action, and every app's moods
// run the one way. Every call is checked against that list again, then by
// the same gate as a client's: an action switched off since the agent listed
// its tools is refused. One offered but off answers `not_allowed` with where
// it's decided; one never offered answers as an unknown tool does, so its
// existence doesn't leak.

type AgentToolsOptions = {
  canUse: () => AiCanUse;
  /** The core's own tools (core-tools.ts). */
  core: CoreTools;
  readableDeviceKinds: () => ReadonlySet<CapabilityKind>;
  places: () => Places;
  devices: Pick<Devices, "list">;
  entities: Pick<Entities, "get">;
  apps: {
    /** An installed app's name. */
    name: (appId: string) => string | undefined;
    action: (appId: string, actionId: string) => DeclaredAction | undefined;
    /** The app's action that runs its entities of a type. */
    runner: (appId: string, typeId: string) => DeclaredAction | undefined;
    recordRefusal: (agentId: string, appId: string, actionId: string) => void;
    call: (request: {
      caller: Caller;
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

const runInput = z.strictObject({
  app: z.string().min(1).max(128),
  key: z.string().min(1).max(128),
});

const runName = "run";

// What `run` says, from the types it runs now: each standard type says what
// running one does, so it stays right whichever apps provide them.
function runToolOf(types: readonly EntityTypeDefinition[]): Tool {
  const kinds = types.map((type) => type.title.toLowerCase()).join(" or ");
  return {
    name: runName,
    title: "Run",
    description: [
      `Runs an entity of a supported type (${kinds}) by the app and key that the entities tool returns. Returns the entity's type and what it did.`,
      ...types.map((type) => type.run!.description),
      notInstructions,
    ].join(" "),
    inputSchema: inputSchemaOf(runInput),
    // Running a mood can turn lights off.
    annotations: {},
  };
}

const notRunnable = () =>
  toolError("not_found", "Nothing that runs has that app and key.");

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

  function actionInputSchemaOf(
    offer: AiOfferInfo,
  ): Tool["inputSchema"] | undefined {
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

  // What AI agents can use, leaving out an assistant app's own offers: it
  // never lists or calls itself.
  function canUseApart(apart: string | undefined): AiCanUse {
    const canUse = options.canUse();
    return apart === undefined
      ? canUse
      : {
          ...canUse,
          offers: canUse.offers.filter((offer) => offer.app !== apart),
        };
  }

  function overview(agent: AgentCaller, canUse: AiCanUse): HomeOverview {
    const places = options.places();
    const kinds = options.readableDeviceKinds();
    return {
      agent: { name: agent.name },
      home: places.home,
      floors: places.floors,
      rooms: places.rooms,
      zones: places.zones,
      devices: options.devices.list({ kinds }).map(overviewDevice),
      notAllowed: notAllowedOf(canUse, apps.name),
      notForAgents,
    };
  }

  return {
    /** The tools, without an assistant app's own when it is `apart`. */
    list(within: { apart?: string } = {}): Tool[] {
      const canUse = canUseApart(within.apart);
      const tools = [overviewTool];
      tools.push(
        ...options.core.list(canUse, { assistant: within.apart !== undefined }),
      );
      const runs = typesRun(runnersOf(canUse).filter(isUsable));
      if (runs.length > 0) tools.push(runToolOf(runs));
      for (const [name, offer] of ownTools(canUse)) {
        if (!isUsable(offer)) continue;
        const inputSchema = actionInputSchemaOf(offer);
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
     * which the endpoint answers as the protocol's unknown tool, as it
     * does an assistant app's own.
     */
    async call(
      agent: AgentCaller,
      name: string,
      input: Record<string, unknown> | undefined,
      within: { apart?: string } = {},
    ): Promise<CallToolResult | undefined> {
      const canUse = canUseApart(within.apart);
      if (name === overviewTool.name) {
        return input !== undefined && Object.keys(input).length > 0
          ? toolError("invalid_input", "The home overview takes no input.")
          : answer(overview(agent, canUse));
      }
      if (name === runName) return run(agent, input ?? {}, canUse);
      const coreResult = await options.core.call(
        name,
        agent,
        input ?? {},
        canUse,
      );
      if (coreResult) return coreResult;
      const offer = ownTools(canUse).get(name);
      if (!offer || !actionInputSchemaOf(offer)) return undefined;
      return callOffer(agent, canUse, offer, input ?? {});
    },
  };

  // An app's offered actions as tools of their own, but for those that run
  // a standard type's entities, which `run` runs.
  function ownTools(canUse: AiCanUse) {
    return namedActions(
      canUse.offers.filter((offer) => !apps.action(offer.app, offer.id)?.runs),
    );
  }

  // Calls an app's offered action for an agent, answering a refusal with
  // where it's decided. The app host has checked what it answers against
  // its output schema.
  async function callOffer(
    agent: AgentCaller,
    canUse: AiCanUse,
    offer: AiOfferInfo,
    input: unknown,
    output: (answered: unknown) => unknown = (answered) => answered,
  ): Promise<CallToolResult> {
    let answered: unknown;
    try {
      answered = await apps.call({
        caller: agent,
        appId: offer.app,
        actionId: offer.id,
        input,
      });
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
          return notAllowed(current, latest, apps.name(offer.app) ?? offer.app);
        }
      }
      return errorAnswer(error);
    }
    return answer(output(answered));
  }

  // The offered actions that run a standard type's entities, on or off.
  function runnersOf(canUse: AiCanUse) {
    return canUse.offers.filter(
      (offer) =>
        offer.kind === "action" &&
        Boolean(apps.action(offer.app, offer.id)?.runs),
    );
  }

  // The standard types these runners run, each once.
  function typesRun(runners: readonly AiOfferInfo[]) {
    const ids = new Set(
      runners.map((offer) => apps.action(offer.app, offer.id)?.runs),
    );
    return standardEntityTypes.filter((type) => type.run && ids.has(type.id));
  }

  // Runs an entity through its app's action that runs its type, with the
  // entity's input, answering its type and what the action answered, the
  // type's run output. An app with no runner offered, a key it hasn't
  // published, a type that doesn't run and one whose runner is off while
  // another of the app's is on all answer alike, and its entities stay
  // unread while its runners are off.
  async function run(
    agent: AgentCaller,
    input: Record<string, unknown>,
    canUse: AiCanUse,
  ): Promise<CallToolResult | undefined> {
    const runners = runnersOf(canUse);
    if (runners.length === 0) return undefined;
    const parsed = runInput.safeParse(input);
    if (!parsed.success) return invalidInput();
    const { app, key } = parsed.data;
    const ofApp = runners.filter((offer) => offer.app === app);
    if (ofApp.length === 0) return notRunnable();
    if (!ofApp.some(isUsable)) {
      const offer = ofApp[0]!;
      apps.recordRefusal(agent.id, app, offer.id);
      return notAllowed(canUse, offer, apps.name(app) ?? app);
    }
    const entity = options.entities.get(app, key);
    const type = standardEntityTypes.find(
      (each) => each.id === entity?.type && each.run,
    );
    const runner = type && apps.runner(app, type.id);
    const offer = runner && ofApp.find((each) => each.id === runner.id);
    if (!entity || !type || !offer || !isUsable(offer)) return notRunnable();
    const ran = (entity.state as { input?: unknown }).input;
    return callOffer(agent, canUse, offer, ran, (result) => ({
      type: type.id,
      result,
    }));
  }
}

export type AgentTools = ReturnType<typeof createAgentTools>;
