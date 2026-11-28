import {
  activityReadPermission,
  aiAreas,
  capabilityKinds,
  capabilityOf,
  controlPermission,
  historyReadPermission,
  peopleReadPermission,
  standardEntityTypes,
  type ActivityInfo,
  type AiCanUse,
  type AiOfferInfo,
  type CapabilityKind,
  type SpeechLanguage,
} from "@meetsanctum/app-sdk";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import type {
  Activity,
  ActivityAuthor,
  NewActivityEntry,
} from "../activity/activity.js";
import type { ActivityViews } from "../activity/views.js";
import { ActionCallError } from "../app-host/errors.js";
import type { AgentCaller } from "../app-host/gate.js";
import type { CommandChange, Devices } from "../devices/devices.js";
import {
  lightsPlace,
  type LightOutcome,
  type Lights,
} from "../devices/lights.js";
import { commandRequest } from "../devices/requests.js";
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
import type { Speech } from "../speech/speech.js";
import { createAnnounceTool } from "./announce-tool.js";
import { assistantOf } from "./assistants.js";
import type { AgentChanges } from "./changes.js";
import {
  areasOff,
  inputSchemaOf,
  isOn,
  Refused,
  type CoreTool,
  type Listing,
} from "./core-tool.js";
import { createRestoreCapability } from "./restore.js";

// The core's own tools, each listed while what it needs is switched on in
// What AI agents can use: `lights` and `device_command` for the kinds AI
// agents may control, with `restore`, which puts an agent's own change of
// either back, `entities` for what apps bring that's switched on,
// `activity` and `history` for their areas, and `announce`, which says
// something on a smart speaker (announce-tool.ts). Each answers with what AI agents
// may see only: devices of the kinds they may read, and the names of people
// and their phones and computers only while "See who lives here" is on. A
// tool called while it's switched off answers `not_allowed`, with where it's
// decided.

type CoreToolsOptions = {
  readableDeviceKinds: () => ReadonlySet<CapabilityKind>;
  appName: (appId: string) => string | undefined;
  devices: Pick<Devices, "get" | "list" | "commandFor">;
  lights: Pick<Lights, "changeFor">;
  changes: AgentChanges;
  entities: Pick<Entities, "list">;
  activity: Pick<Activity, "page">;
  activityViews: Pick<ActivityViews, "info">;
  history: Pick<History, "states" | "statistics">;
  record: (entry: NewActivityEntry) => string;
  agentWho: (id: string) => ActivityAuthor;
  // What Sanctum says out loud, for announce; a core without it has none.
  speech?: Pick<Speech, "speak">;
  // The home's language for speech, which announcements are in unless
  // they say otherwise.
  language?: () => SpeechLanguage;
  now?: () => Date;
};

const isUsable = (offer: AiOfferInfo) => offer.on && offer.missing.length === 0;

// An entity's state as AI agents read it. One that runs, such as a mood,
// leaves out its input, which only its app's action reads: agents run it by
// its app and key.
function stateForAgents(type: string, state: unknown) {
  const runs = standardEntityTypes.some((each) => each.id === type && each.run);
  if (!runs || typeof state !== "object" || state === null) return state;
  const { input: _, ...rest } = state as Record<string, unknown>;
  return rest;
}

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

function batchAnswer(
  result: Record<string, unknown>,
  outcomes: readonly { why?: string }[],
  limitedMessage?: string,
): CallToolResult {
  if (outcomes.some(({ why }) => why === "forbidden")) {
    throw new ActionCallError("forbidden");
  }
  if (outcomes.some(({ why }) => why === "needs_approval")) {
    throw new ActionCallError("needs_approval");
  }
  if (outcomes.some(({ why }) => why === "limited")) {
    const refusal = limitedMessage
      ? toolError("limited", limitedMessage)
      : errorAnswer(new ActionCallError("limited"));
    return {
      ...answer(Object.assign({}, refusal.structuredContent, result)),
      isError: true,
    };
  }
  return answer(result);
}

export function createCoreTools(options: CoreToolsOptions) {
  const now = options.now ?? (() => new Date());
  const view = (): View => ({ kinds: options.readableDeviceKinds() });

  const brightness = z.number().int().min(1).max(100);
  const colorTemperature = z.number().int().min(50).max(1000);
  const lightsInput = z.union([
    z.strictObject({
      place: lightsPlace,
      to: z.enum(["on", "off", "brighter", "dimmer"]),
    }),
    z.strictObject({
      place: lightsPlace,
      set: z.union([
        z.strictObject({ brightness }),
        z.strictObject({ brightness: brightness.optional(), colorTemperature }),
        z.strictObject({
          brightness: brightness.optional(),
          hue: z.number().min(0).max(360),
          saturation: z.number().min(0).max(100),
        }),
      ]),
    }),
  ]);

  const lights: CoreTool = {
    tool: () => ({
      name: "lights",
      title: "Lights",
      description: [
        "Change lights: a room's, a floor's, a zone's, the whole home's, or chosen lights by device and capability, with the ids home_overview gives.",
        "`to` turns them on or off, or steps them brighter or dimmer by a fifth of their range, as a dimmer's press does; dimmer leaves lights that are off alone.",
        "`set` sets a brightness from 1 to 100, a white as a colour temperature in mireds (1,000,000 divided by kelvin: 370 is warm white, 250 is neutral), or a colour as hue (0 to 360) and saturation (0 to 100). Brightness is optional when setting a white or a colour.",
        "A colour reaches lights that can show it, even those that are off. A white also turns on fixed-white lights. The lights come on at the level asked or else at the level of the lights that are on, even if the room's rule would keep them off.",
        "A brightness alone adjusts the look the place has: while any light is on, only those change, so a mood's other lights stay off; while none is, the place comes on as turning on does, at that level. To light every light brightly, set a white with the brightness.",
        "Turning on goes by the room's own rule, as its lights button does, such as a mood's look or natural light's.",
        "The answer lists every light: sent, confirmed, skipped with why, or offline, and a `change` that restore puts back.",
        "Ask which room when the person names none or two match, and change the whole home only when the person said so. Then say what changed.",
        notInstructions,
      ].join(" "),
      inputSchema: inputSchemaOf(lightsInput),
      annotations: {},
    }),
    usable: (canUse) => isOn(canUse, controlPermission("light")),
    refusal: () => areasOff([controlPermission("light")]),
    async run(agent, input) {
      const parsed = lightsInput.safeParse(input);
      if (!parsed.success) return invalidInput();
      const { place, ...ask } = parsed.data;
      const outcomes = await options.lights.changeFor(
        agent,
        place,
        ask,
        view(),
      );
      const change = options.changes.record(
        agent,
        outcomes.flatMap(({ device, capability, change }) =>
          change ? [{ device, capability, kind: "light", ...change }] : [],
        ),
      );
      return batchAnswer(
        { change, lights: outcomes.map(lightAnswer) },
        outcomes,
      );
    },
  };

  // One light as the agent hears of it: without how it was before, which
  // only restore goes by.
  const lightAnswer = ({ change: _change, ...outcome }: LightOutcome) =>
    outcome;

  const commandInput = z.strictObject({
    device: commandRequest.shape.device,
    capability: commandRequest.shape.capability,
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
    async run(agent, input, canUse) {
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
      const address = { device: device.id, capability: capability.id };
      let accepted: CommandChange | undefined;
      const after = await options.devices.commandFor(
        agent,
        { ...address, command },
        {
          accepted: (change) => {
            accepted = change;
          },
        },
      );
      const { kind } = capability;
      const change =
        accepted && (kind === "light" || kind === "switch")
          ? options.changes.record(agent, [{ ...address, kind, ...accepted }])
          : null;
      return answer({
        change,
        device: device.id,
        capability: after.id,
        kind: after.kind,
        state: after.state,
        // What the device has yet to confirm.
        waitingFor: after.sync === "pending" ? after.desired : null,
      });
    },
  };

  const changeId = z.string().min(1).max(64);
  const restoreInput = z.strictObject({ change: changeId });
  // An assistant app may leave the change out, for the last one it made for
  // this device: a person says "put it back" after the window of its earlier
  // exchanges has gone.
  const assistantRestoreInput = z.strictObject({ change: changeId.optional() });

  const putBack = createRestoreCapability({
    devices: options.devices,
    appName: options.appName,
    view,
  });

  const restore: CoreTool = {
    tool: (_canUse, { assistant }) => ({
      name: "restore",
      title: "Put back",
      description: [
        assistant
          ? "Put back one of your own changes: the `change` a lights or device_command call answered with, or, left out, your last change if you haven't run a mood since."
          : "Put back one of your own changes: the `change` a lights or device_command call answered with.",
        "Each light or switch that still shows what you set goes back to how it was. One changed since, by a person, a switch or an app, is left as it is and named, with the app where one changed it; one whose command is still on its way is uncertain.",
        "Only your last 5 changes are kept, for an hour. Putting back a change twice answers the same. A mood's run can't be put back this way.",
        notInstructions,
      ].join(" "),
      inputSchema: inputSchemaOf(
        assistant ? assistantRestoreInput : restoreInput,
      ),
      annotations: {},
    }),
    usable: (canUse) => controlKinds(canUse).length > 0,
    refusal: () => areasOff(deviceCommandAreas),
    async run(agent, input, canUse) {
      const parsed = (
        assistantOf(agent.id) ? assistantRestoreInput : restoreInput
      ).safeParse(input);
      if (!parsed.success) return invalidInput();
      const asked = parsed.data.change;
      const change =
        asked === undefined
          ? options.changes.last(agent)
          : options.changes.find(agent, asked);
      if (change === "mood") {
        return toolError("mood_not_restorable", "I can't undo a mood.");
      }
      if (!change) {
        return toolError(
          "change_gone",
          asked === undefined
            ? "There's no change of yours to put back: only your last 5 changes are kept, for an hour."
            : "That change can't be put back: only your last 5 changes are kept, for an hour.",
        );
      }
      const off = [
        ...new Set(change.changed.map((item) => controlPermission(item.kind))),
      ].filter((area) => !isOn(canUse, area));
      if (off.length > 0) throw areasOff(off);
      change.restored ??= Promise.all(
        change.changed.map((item) => putBack(agent, item)),
      )
        .then((changed) => {
          // A wholly refused restore can be tried again after the limit resets.
          if (
            changed.some(({ why }) => why === "limited") &&
            !changed.some(
              ({ result }) => result === "sent" || result === "confirmed",
            )
          ) {
            throw new ActionCallError("limited");
          }
          return batchAnswer(
            { change: change.id, changed },
            changed,
            "The device command limit stopped some lights or switches from being put back.",
          );
        })
        .catch((error: unknown) => {
          delete change.restored;
          throw error;
        });
      return change.restored;
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
    async run(_agent, input, canUse) {
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
            state: stateForAgents(entity.type, entity.state),
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
    canNamePeople: boolean,
    canSeeRemote: (device: string) => boolean,
  ) {
    switch (who.kind) {
      case "person":
      case "client":
        return canNamePeople
          ? { kind: who.kind, name: who.name }
          : { kind: who.kind };
      case "agent":
        if (who.id === self) return { kind: "agent", self: true };
        return canNamePeople
          ? { kind: "agent", name: who.name }
          : { kind: "agent" };
      case "press":
        return canSeeRemote(who.device)
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
    async run(agent, input, canUse) {
      const parsed = activityInput.safeParse(input);
      if (!parsed.success) return invalidInput();
      const seen = view();
      const { device: deviceId } = parsed.data;
      const target =
        deviceId === undefined ? null : options.devices.get(deviceId, seen);
      if (deviceId !== undefined && !target) {
        return toolError("not_found", "There's no such device in the home.");
      }
      const devices = new Map(
        (target ? [target] : options.devices.list(seen)).map((device) => [
          device.id,
          device,
        ]),
      );
      const canNamePeople = isOn(canUse, peopleReadPermission);
      const canSeeRemote = (id: string) =>
        (devices.get(id) ?? options.devices.get(id, seen))?.capabilities.some(
          (capability) => capability.kind === "button",
        ) === true;
      const self = agent.id;
      const page = options.activity.page({
        kind: "devices",
        subjectId: deviceId,
        deviceCapabilities: Object.fromEntries(
          [...devices.values()].map(({ id, capabilities }) => [
            id,
            Object.fromEntries(capabilities.map(({ id, kind }) => [id, kind])),
          ]),
        ),
        before: parsed.data.before,
        limit: parsed.data.limit,
        forAgents: true,
      });
      const entries = page.entries.map((entry) => {
        const device = devices.get(entry.subjectId!)!;
        const info = options.activityViews.info(entry);
        const mine = entry.actor === `assistant-run:${self}`;
        return {
          at: info.at,
          action: info.action,
          outcome: info.outcome,
          reason: info.reason,
          ...(info.count > 1 && { count: info.count }),
          device: { id: device.id, name: device.name },
          detail: info.detail,
          who: whoFor(info.who, self, canNamePeople, canSeeRemote),
          app: info.app?.name ?? null,
          automation: info.run?.name ?? null,
          ...(mine && entry.callId && { call: entry.callId }),
        };
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
        "`from` and `to` are ISO times, the last day unless given, and go back 10 days at most. Use at most two days per request for 5-minute roll-ups.",
        notInstructions,
      ].join(" "),
      inputSchema: inputSchemaOf(historyInput),
      annotations: { readOnlyHint: true },
    }),
    usable: (canUse) => isOn(canUse, historyReadPermission),
    refusal: () => areasOff([historyReadPermission]),
    async run(_agent, input) {
      const parsed = historyInput.safeParse(input);
      if (!parsed.success) return invalidInput();
      const {
        period,
        from: requestedFrom,
        to: requestedTo,
        ...target
      } = parsed.data;
      const at = now();
      const earliest = at.getTime() - historyTimes.statesKeptMs;
      // A day until `to` unless asked, as history reads.
      const to = requestedTo ?? at;
      const from =
        requestedFrom ?? new Date(to.getTime() - 24 * historyTimes.hourMs);
      if (from.getTime() < earliest) {
        return toolError(
          "invalid_input",
          "History goes back 10 days at most for AI agents.",
        );
      }
      const query = { ...target, from, to };
      if (period !== undefined) {
        return answer(options.history.statistics(view(), { ...query, period }));
      }
      const result = options.history.states(view(), query);
      // History can include an older sample to seed the range's initial state.
      return answer({
        ...result,
        states: result.states.filter(({ at }) => Date.parse(at) >= earliest),
      });
    },
  };

  const tools: Record<string, CoreTool> = {
    lights,
    device_command: deviceCommand,
    restore,
    entities,
    activity,
    history,
    ...(options.speech && {
      announce: createAnnounceTool({
        devices: options.devices,
        speech: options.speech,
        language: options.language ?? (() => "en"),
        record: options.record,
        agentWho: options.agentWho,
      }),
    }),
  };

  // A refusal goes to the activity log once, under the agent's name.
  function refused(agent: AgentCaller, tool: string, refusal: Refused) {
    options.record({
      action: "agents.refused",
      outcome: "refused",
      reason: "forbidden",
      ...options.agentWho(agent.id),
      detail: { tool, items: [...refusal.items] },
    });
    return refusal.answer;
  }

  return {
    /** Those listed now, from what's switched on. */
    list: (canUse: AiCanUse, listing: Listing = { assistant: false }) =>
      Object.values(tools)
        .filter((tool) => tool.usable(canUse))
        .map((tool) => tool.tool(canUse, listing)),

    /** Runs one, answering its refusals and failures by their code. */
    async call(
      name: string,
      agent: AgentCaller,
      input: Record<string, unknown>,
      canUse: AiCanUse,
    ): Promise<CallToolResult | undefined> {
      if (!Object.hasOwn(tools, name)) return undefined;
      const tool = tools[name]!;
      if (!(tool.callable ?? tool.usable)(canUse)) {
        return refused(agent, name, tool.refusal(canUse));
      }
      try {
        return await tool.run(agent, input, canUse);
      } catch (error) {
        if (error instanceof Refused) return refused(agent, name, error);
        return errorAnswer(error);
      }
    },
  };
}

export type CoreTools = ReturnType<typeof createCoreTools>;
