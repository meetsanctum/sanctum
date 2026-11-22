import {
  activityReadPermission,
  aiAreas,
  capabilityKinds,
  capabilityOf,
  controlPermission,
  historyReadPermission,
  peopleReadPermission,
  permissionWords,
  type ActivityInfo,
  type AiCanUse,
  type AiOfferInfo,
  type CapabilityKind,
} from "@meetsanctum/app-sdk";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { z } from "zod";

import type {
  Activity,
  ActivityAuthor,
  ActivityEntry,
  NewActivityEntry,
} from "../activity/activity.js";
import type { ActivityViews } from "../activity/views.js";
import type { Principal } from "../auth/clients.js";
import type { Devices } from "../devices/devices.js";
import { lightsPlace, type Lights } from "../devices/lights.js";
import type { View } from "../devices/views.js";
import type { Entities } from "../entities/entities.js";
import {
  statesQuery,
  statisticsQuery,
  type History,
} from "../history/history.js";
import { historyTimes } from "../history/time.js";
import {
  answer,
  errorAnswer,
  invalidInput,
  notInstructions,
  toolError,
} from "./answers.js";
import { areasPage } from "./overview.js";

// The core's own tools, each listed while what it needs is switched on in
// What AI agents can use: `lights` and `device_command` for the kinds AI
// agents may control, `entities` for what apps bring that's switched on,
// `activity` and `history` for their areas. Each answers with what AI agents
// may see only: devices of the kinds they may read, and the names of people
// and their phones and computers only while "See who lives here" is on. A
// tool called while it's switched off answers `not_allowed`, with where it's
// decided.

type AgentPrincipal = Extract<Principal, { scope: "agent" }>;

export type CoreToolsOptions = {
  readableDeviceKinds: () => ReadonlySet<CapabilityKind>;
  appName: (appId: string) => string | undefined;
  devices: Pick<Devices, "get" | "commandFor">;
  lights: Pick<Lights, "switchFor">;
  entities: Pick<Entities, "list">;
  activity: Pick<Activity, "page">;
  activityViews: Pick<ActivityViews, "info">;
  history: Pick<History, "states" | "statistics">;
  record: (entry: NewActivityEntry) => string;
  agentWho: (id: string) => ActivityAuthor;
  now?: () => Date;
};

type CoreTool = {
  /** As listed, from what's switched on now. */
  tool: (canUse: AiCanUse) => Tool;
  /** Whether it's listed: what it needs is on. */
  usable: (canUse: AiCanUse) => boolean;
  /** Why it can't be used, when it's called anyway. */
  refusal: (canUse: AiCanUse) => Refused;
  run: (
    principal: AgentPrincipal,
    input: Record<string, unknown>,
    canUse: AiCanUse,
  ) => Promise<CallToolResult>;
};

const isOn = (canUse: AiCanUse, area: string) =>
  canUse.areas.some((each) => each.id === area && each.on);

const titleOf = (area: string) => permissionWords(area).title;

// A refusal of what's switched off, or isn't for AI agents, with the areas
// behind it, which the activity log names.
class Refused extends Error {
  constructor(
    readonly answer: CallToolResult,
    readonly items: readonly string[],
  ) {
    super("refused");
  }
}

function areasOff(areas: readonly string[]) {
  const titles = areas.map((area) => `“${titleOf(area)}”`).join(" and ");
  const are = areas.length > 1 ? "are" : "is";
  return new Refused(
    toolError(
      "not_allowed",
      `${titles} ${are} switched off for AI agents in ${areasPage}.`,
    ),
    areas,
  );
}

const isUsable = (offer: AiOfferInfo) => offer.on && offer.missing.length === 0;

const inputSchemaOf = (schema: z.ZodType): Tool["inputSchema"] => {
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return { ...json, type: "object" };
};

// The kinds AI agents may control, of those any area offers.
const controlKinds = (canUse: AiCanUse) =>
  capabilityKinds.filter(
    (kind) =>
      aiAreas.includes(controlPermission(kind)) &&
      isOn(canUse, controlPermission(kind)),
  );

const deviceCommandAreas = capabilityKinds
  .map(controlPermission)
  .filter((area) => aiAreas.includes(area));

// What an entry about a device says, by the capability it names: a press is
// a remote's, and a command or a change outside Sanctum is one capability's.
function capabilityOfEntry(entry: ActivityEntry) {
  const capability = entry.detail?.capability;
  return typeof capability === "string" ? capability : undefined;
}

export function createCoreTools(options: CoreToolsOptions) {
  const now = options.now ?? (() => new Date());
  const view = (): View => ({ kinds: options.readableDeviceKinds() });

  const lightsInput = z.strictObject({
    place: lightsPlace,
    to: z.enum(["on", "off"]),
  });

  const lights: CoreTool = {
    tool: () => ({
      name: "lights",
      title: "Lights",
      description: [
        "Turn lights on or off: a room's, a floor's, a zone's, the whole home's, or chosen lights by device and capability, with the ids home_overview gives.",
        "Turning on goes by the room's own rule, as its lights button does, such as a mood's look or natural light's. Lights that aren't answering are left alone.",
        "Ask which room when the person names none or two match, and switch the whole home only when the person said so. Then say what changed.",
        notInstructions,
      ].join(" "),
      inputSchema: inputSchemaOf(lightsInput),
      annotations: {},
    }),
    usable: (canUse) => isOn(canUse, controlPermission("light")),
    refusal: () => areasOff([controlPermission("light")]),
    async run(principal, input) {
      const parsed = lightsInput.safeParse(input);
      if (!parsed.success) return invalidInput();
      const result = await options.lights.switchFor(principal, parsed.data);
      return answer({
        on: result.on,
        switched: result.switched,
        failed: result.failed.map((light) => ({
          ...light,
          name: options.devices.get(light.device)?.name ?? null,
        })),
      });
    },
  };

  const commandInput = z.strictObject({
    device: z.string().min(1).max(64),
    capability: z.string().min(1).max(32),
    command: z.record(z.string(), z.unknown()),
  });

  const deviceCommand: CoreTool = {
    tool(canUse) {
      const kinds = controlKinds(canUse);
      const commands = kinds.map(
        (kind) => capabilityOf(kind).command as z.ZodType,
      );
      const schema = commandInput.extend({
        command:
          commands.length > 1
            ? z.union(commands as [z.ZodType, z.ZodType, ...z.ZodType[]])
            : commands[0]!,
      });
      return {
        name: "device_command",
        title: "Device command",
        description: [
          `Send one device's capability a command, such as turning a plug on: the command its kind takes, for the kinds you may control (${kinds.join(", ")}).`,
          "Find the device and its capability in home_overview first, and ask when it's unclear which one is meant. For a room's lights, use lights.",
          "The answer is the capability's state with what's still on its way to the device.",
          notInstructions,
        ].join(" "),
        inputSchema: inputSchemaOf(schema),
        annotations: {},
      };
    },
    usable: (canUse) => controlKinds(canUse).length > 0,
    refusal: () => areasOff(deviceCommandAreas),
    async run(principal, input, canUse) {
      const parsed = commandInput.safeParse(input);
      if (!parsed.success) return invalidInput();
      const { device: id, capability: capabilityId, command } = parsed.data;
      // What AI agents can't see isn't there for them.
      const device = options.devices.get(id, view());
      const capability = device?.capabilities.find(
        (each) => each.id === capabilityId,
      );
      if (!device || !capability) {
        return toolError("not_found", "There's no such device in the home.");
      }
      const area = controlPermission(capability.kind);
      if (!aiAreas.includes(area)) {
        throw new Refused(
          toolError(
            "not_allowed",
            `Changing “${device.name}” isn't for AI agents: a person does that in Settings, Devices.`,
          ),
          [area],
        );
      }
      if (!isOn(canUse, area)) throw areasOff([area]);
      const after = await options.devices.commandFor(principal, {
        device: device.id,
        capability: capability.id,
        command,
      });
      return answer({
        device: device.id,
        capability: after.id,
        kind: after.kind,
        state: after.state,
        // What the device has yet to confirm.
        waitingFor: after.sync === "pending" ? after.desired : null,
      });
    },
  };

  const entitiesInput = z.strictObject({
    type: z.string().min(1).max(128).optional(),
  });

  // The types of what apps bring that AI agents may read, and which app
  // brings each.
  const readableEntities = (canUse: AiCanUse) =>
    canUse.offers.filter(
      (offer) =>
        offer.kind === "entity" &&
        isUsable(offer) &&
        options.appName(offer.app) !== undefined,
    );

  const entities: CoreTool = {
    tool(canUse) {
      const types = readableEntities(canUse).map(
        (offer) =>
          `${offer.id} (“${offer.title}”, from ${options.appName(offer.app)})`,
      );
      return {
        name: "entities",
        title: "What apps bring",
        description: [
          "What the home's apps bring, such as moods or a forecast, by type: only what's switched on for AI agents.",
          `The types you can read: ${types.join("; ")}.`,
          notInstructions,
        ].join(" "),
        inputSchema: inputSchemaOf(entitiesInput),
        annotations: { readOnlyHint: true },
      };
    },
    usable: (canUse) => readableEntities(canUse).length > 0,
    refusal: () =>
      new Refused(
        toolError(
          "not_allowed",
          "Nothing apps bring is switched on for AI agents: each app's settings decide it.",
        ),
        [],
      ),
    async run(_principal, input, canUse) {
      const parsed = entitiesInput.safeParse(input);
      if (!parsed.success) return invalidInput();
      const readable = new Set(
        readableEntities(canUse).map((offer) => `${offer.app} ${offer.id}`),
      );
      return answer({
        entities: options.entities
          .list({ type: parsed.data.type })
          .filter((entity) => readable.has(`${entity.app} ${entity.type}`))
          .map((entity) => ({
            app: entity.app,
            appName: options.appName(entity.app) ?? null,
            key: entity.key,
            type: entity.type,
            name: entity.name,
            state: entity.state,
            updatedAt: entity.updatedAt,
          })),
      });
    },
  };

  const activityInput = z.strictObject({
    device: z.string().min(1).max(64).optional(),
    before: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  });

  // Who did it, as far as AI agents may know: people, their phones and
  // computers and other agents by name only while "See who lives here" is
  // on, and a remote's press only while remotes are.
  function whoFor(
    who: ActivityInfo["who"],
    self: string,
    namesPeople: boolean,
    kinds: ReadonlySet<CapabilityKind>,
  ) {
    switch (who.kind) {
      case "person":
      case "client":
        return namesPeople
          ? { kind: who.kind, name: who.name }
          : { kind: who.kind };
      case "agent":
        if (who.id === self) return { kind: "agent", self: true };
        return namesPeople
          ? { kind: "agent", name: who.name }
          : { kind: "agent" };
      case "press":
        return kinds.has("button")
          ? { kind: "press", remote: who.name, action: who.action }
          : { kind: "press" };
      case "workflow":
        return { kind: "automation", name: who.name };
      case "app":
        return { kind: "app", name: who.name };
      default:
        return { kind: who.kind };
    }
  }

  const activity: CoreTool = {
    tool: () => ({
      name: "activity",
      title: "Activity",
      description: [
        "What happened to the home's devices, newest first, for the devices you may see: commands, changes at a wall switch or in a maker's app, presses, devices going offline and back.",
        "Give a device's id for one device's, and `before` with the `next` of an answer for older ones. Entries from your own calls say `self` and carry the call's id.",
        notInstructions,
      ].join(" "),
      inputSchema: inputSchemaOf(activityInput),
      annotations: { readOnlyHint: true },
    }),
    usable: (canUse) => isOn(canUse, activityReadPermission),
    refusal: () => areasOff([activityReadPermission]),
    async run(principal, input, canUse) {
      const parsed = activityInput.safeParse(input);
      if (!parsed.success) return invalidInput();
      const kinds = options.readableDeviceKinds();
      const seen = view();
      const namesPeople = isOn(canUse, peopleReadPermission);
      const self = principal.client.id;
      const page = options.activity.page({
        kind: "devices",
        subjectId: parsed.data.device,
        before: parsed.data.before,
        limit: parsed.data.limit,
      });
      const entries = page.entries.flatMap((entry) => {
        const device = entry.subjectId
          ? options.devices.get(entry.subjectId, seen)
          : null;
        if (!device) return [];
        const capability = capabilityOfEntry(entry);
        if (
          capability !== undefined &&
          !device.capabilities.some((each) => each.id === capability)
        ) {
          return [];
        }
        if (entry.action === "device.press" && !kinds.has("button")) return [];
        const info = options.activityViews.info(entry);
        const mine = entry.actor === `assistant-run:${self}`;
        return [
          {
            at: info.at,
            action: info.action,
            outcome: info.outcome,
            reason: info.reason,
            ...(info.count > 1 && { count: info.count }),
            device: { id: device.id, name: device.name },
            detail: info.detail,
            who: whoFor(info.who, self, namesPeople, kinds),
            app: info.app?.name ?? null,
            automation: info.run?.name ?? null,
            ...(mine && entry.callId && { call: entry.callId }),
          },
        ];
      });
      return answer({
        entries,
        next: page.more ? (page.entries.at(-1)?.id ?? null) : null,
      });
    },
  };

  const historyInput = z.strictObject({
    ...statesQuery.shape,
    period: statisticsQuery.shape.period.optional(),
  });

  const history: CoreTool = {
    tool: () => ({
      name: "history",
      title: "History",
      description: [
        "What one device's capability reported, for devices whose history the household keeps and that you may see: each change, or with `period` its 5-minute or hourly minimum, maximum and mean.",
        "`from` and `to` are ISO times, the last day unless given, and go back 10 days at most.",
        notInstructions,
      ].join(" "),
      inputSchema: inputSchemaOf(historyInput),
      annotations: { readOnlyHint: true },
    }),
    usable: (canUse) => isOn(canUse, historyReadPermission),
    refusal: () => areasOff([historyReadPermission]),
    async run(_principal, input) {
      const parsed = historyInput.safeParse(input);
      if (!parsed.success) return invalidInput();
      const { period, ...query } = parsed.data;
      const earliest = now().getTime() - historyTimes.statesKeptMs;
      // A day until `to` unless asked, as history reads.
      const from =
        query.from ??
        new Date((query.to ?? now()).getTime() - 24 * historyTimes.hourMs);
      if (from.getTime() < earliest) {
        return toolError(
          "invalid_input",
          "History goes back 10 days at most for AI agents.",
        );
      }
      return answer(
        period === undefined
          ? options.history.states(view(), query)
          : options.history.statistics(view(), { ...query, period }),
      );
    },
  };

  const tools: Record<string, CoreTool> = {
    lights,
    device_command: deviceCommand,
    entities,
    activity,
    history,
  };

  // A refusal goes to the activity log once, under the agent's name.
  function refused(principal: AgentPrincipal, tool: string, refusal: Refused) {
    options.record({
      action: "agents.refused",
      outcome: "refused",
      reason: "forbidden",
      ...options.agentWho(principal.client.id),
      detail: { tool, items: [...refusal.items] },
    });
    return refusal.answer;
  }

  return {
    /** Those listed now, from what's switched on. */
    list: (canUse: AiCanUse) =>
      Object.values(tools)
        .filter((tool) => tool.usable(canUse))
        .map((tool) => tool.tool(canUse)),

    has: (name: string) => Object.hasOwn(tools, name),

    /** Runs one, answering its refusals and failures by their code. */
    async call(
      name: string,
      principal: AgentPrincipal,
      input: Record<string, unknown>,
      canUse: AiCanUse,
    ): Promise<CallToolResult> {
      const tool = tools[name]!;
      if (!tool.usable(canUse)) {
        return refused(principal, name, tool.refusal(canUse));
      }
      try {
        return await tool.run(principal, input, canUse);
      } catch (error) {
        if (error instanceof Refused) return refused(principal, name, error);
        return errorAnswer(error);
      }
    },
  };
}

export type CoreTools = ReturnType<typeof createCoreTools>;
