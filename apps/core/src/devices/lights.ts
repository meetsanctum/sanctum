import {
  choice,
  names,
  partOf,
  turnOnRanks,
  turnOnSchema,
  turnOnType,
  type Actor,
  type LightCommand,
  type LightState,
  type LightsChange,
  type LightsPlace,
  type LightsResult,
  type LightsSet,
  type LightsSwitch,
  type TurnOnLight,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import { ActionCallError } from "../app-host/errors.js";
import {
  deviceCommandRule,
  type AgentCaller,
  type Gate,
} from "../app-host/gate.js";
import type { Principal } from "../auth/clients.js";
import type { Entities } from "../entities/entities.js";
import { roomsOfPlace, type PlacesModule } from "../places/places.js";
import type { CommandChange, Devices } from "./devices.js";
import type { HoldDirection, Holds, Remote } from "./holds.js";
import {
  canDim,
  fieldsOf,
  isOn,
  keyOf,
  lookOf,
  stepOf,
  withSettings,
  type Light,
} from "./light-commands.js";
import { prepare } from "./sync.js";
import type { View } from "./views.js";

// The lights of a room, a floor, a zone or the whole home together: a
// room's Lights tile, which also sets their brightness or colour together,
// a floor's button and Lights' card, and the lights condition and step of
// workflows, so they work with no lighting app. Toggling turns them all
// off while any is on, and on otherwise. A light that is offline is left
// alone and does not count, and "all off" means none is on: a light that
// has yet to report counts as not on. Each light's command passes the gate
// as the caller, like any other. What turning a room on brings is an app's
// rule, such as Moods' scheduled mood, natural light's look or what the
// room was before it went dark: the app publishes it as the room's
// lights.turnOn entity, which the core reads by type here, so no app code
// runs at the press, and the highest-ranked rule for a room holds. A
// floor, a zone or the home go room by room. Without one, every light comes
// on at full brightness, unless the core holds a look for it, so a light
// dimmed to nothing before it went off can't come back looking as if it
// never came on. A workflow whose place is a room, a floor or a zone that
// was removed is broken. Chosen lights are a place of their own, and a
// workflow with one of them removed is broken too. The step also makes
// lights brighter or dimmer by a fifth of their range, and brightens or
// dims them while the remote's button that ran it is held (holds.ts);
// lights that cannot dim are left alone by both. An AI agent turns a
// place's lights on or off, steps them, or sets a brightness, a white or a
// colour as the room's Lights tile does, and hears of every light it may
// see there, offline ones too, with how each sent one was before, so its
// change can be put back.

// A place's schema says `place`, so Automations' editor offers one picker
// for the room, the floor, the zone or the home rather than a field for
// each part.
export const lightsPlace = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("room"), id: names("room") }),
    z.strictObject({ kind: z.literal("floor"), id: names("floor") }),
    z.strictObject({ kind: z.literal("zone"), id: names("zone") }),
    z.strictObject({ kind: z.literal("home") }),
    z.strictObject({
      kind: z.literal("lights"),
      lights: z
        .array(
          z.strictObject({
            device: names("device"),
            capability: partOf("device"),
          }),
        )
        .min(1)
        .max(200),
    }),
  ])
  .meta({ place: true }) satisfies z.ZodType<LightsPlace>;

export const lightsSwitch = choice({
  toggle: "on or off",
  on: "on",
  off: "off",
}) satisfies z.ZodType<LightsSwitch>;

// What the step does, each read at the start of its sentence.
export const lightsChange = choice({
  toggle: "Turn on or off",
  on: "Turn on",
  off: "Turn off",
  brighter: "Brighten",
  dimmer: "Dim",
  brightenWhileHeld: "While held, brighten",
  dimWhileHeld: "While held, dim",
  brightenOrDimWhileHeld: "While held, brighten or dim",
}) satisfies z.ZodType<LightsChange>;

const held: Partial<Record<LightsChange, HoldDirection>> = {
  brightenWhileHeld: "up",
  dimWhileHeld: "down",
  brightenOrDimWhileHeld: "turns",
};

export const lightsAre = choice({
  anyOn: "any light is on",
  allOff: "every light is off",
});

const lightsSet = z.union([
  z.strictObject({ brightness: z.number().int().min(0).max(100) }),
  z.strictObject({ colorTemperature: z.number().int().min(50).max(1000) }),
  z.strictObject({
    hue: z.number().min(0).max(360),
    saturation: z.number().min(0).max(100),
  }),
]) satisfies z.ZodType<LightsSet>;

const request = z.union([
  z.strictObject({ place: lightsPlace, to: lightsSwitch }),
  z.strictObject({ place: lightsPlace, set: lightsSet }),
]);

/** What an AI agent asks of a place's lights. */
type LightsAsk =
  | { to: "on" | "off" | "brighter" | "dimmer"; set?: undefined }
  | {
      to?: undefined;
      set: {
        brightness?: number;
        colorTemperature?: number;
        hue?: number;
        saturation?: number;
      };
    };

type SetField = "brightness" | "colorTemperature" | "color";

/** What an AI agent's ask did to one light. */
export type LightOutcome = {
  device: string;
  capability: string;
  name: string;
  // Sent and on its way, confirmed by the light, left alone, offline, or
  // refused on the way.
  result: "sent" | "confirmed" | "skipped" | "offline" | "failed";
  // Why it was left alone or failed: already there, kept off by its room's
  // rule, off (dimmer, and a brightness while another light is on, leave
  // those), without what was asked, or the code.
  why?: string;
  // What was asked that the light can't do, while the rest was sent.
  ignored?: SetField[];
  // For a light sent a command: the fields it asked for, and how the light
  // was before, which putting the change back goes by.
  change?: CommandChange;
  state: LightState | null;
};

type Planned = { light: Light; ignored?: SetField[] } & (
  { command: LightCommand; why?: never } | { command?: never; why: string }
);

// Refusals for whoever is behind the call, which refuse the whole call
// rather than fail one light: an AI agent past its limit of commands too.
const refusals = new Set(["forbidden", "needs_approval", "limited"]);

export function createLights(options: {
  devices: Pick<Devices, "list" | "command" | "commandFor">;
  places: Pick<PlacesModule, "list">;
  gate: Gate;
  entities: Pick<Entities, "list">;
  holds: Pick<Holds, "start" | "settle" | "isMoving">;
  checkAgentCommand: (id: string, shouldCount: boolean) => void;
  now?: () => Date;
}) {
  const { devices, gate } = options;
  const now = options.now ?? (() => new Date());

  // What turning each room on does for its lights: the highest-ranked
  // lights.turnOn for the room that holds, the first app's of those ranked
  // alike.
  function turnOnRules() {
    const at = now().getTime();
    const best = new Map<
      string,
      { rank: number; lights: Map<string, TurnOnLight["state"]> }
    >();
    for (const entity of options.entities.list({
      type: turnOnType.id,
    })) {
      const parsed = turnOnSchema.safeParse(entity.state);
      if (!parsed.success) continue;
      const { placeId, lights, until } = parsed.data;
      if (until !== null && Date.parse(until) <= at) continue;
      const rank = turnOnRanks.indexOf(parsed.data.rank);
      const kept = best.get(placeId);
      if (kept && kept.rank <= rank) continue;
      best.set(placeId, {
        rank,
        lights: new Map(
          lights.map((light) => [
            keyOf(light.device, light.capability),
            light.state,
          ]),
        ),
      });
    }
    return new Map([...best].map(([placeId, { lights }]) => [placeId, lights]));
  }

  // A light that comes on with nothing to go by: at full brightness, unless
  // the core holds a look for it, which it comes back at.
  function withNothingToGoBy(light: Light): LightCommand {
    const { capability } = light;
    // An off can reserve its next look before the device confirms the off.
    const hasLook =
      capability.sync === "held" ||
      (capability.sync === "pending" &&
        capability.desired?.on === false &&
        Object.keys(capability.desired).some((field) => field !== "on"));
    return canDim(light) && !hasLook
      ? { on: true, brightness: 100 }
      : { on: true };
  }

  // The commands that turn a place's lights on, room by room: each light
  // that is off as its room's rule says, where it names the light, and as
  // the core remembers it where it doesn't. A room with none of its lights
  // on whose rule would leave them all off is switched on as if it had none,
  // since on never means nothing comes on. A room with a light on already
  // keeps the lights its rule keeps off.
  function turningOn(lights: readonly Light[]) {
    const rules = turnOnRules();
    const litRooms = new Set(
      lights.filter(isOn).map((light) => light.device.roomId),
    );
    for (const light of lights) {
      const { device, capability } = light;
      if (
        rules.get(device.roomId ?? "")?.get(keyOf(device.id, capability.id))
          ?.on !== false
      ) {
        litRooms.add(device.roomId);
      }
    }
    return lights
      .filter((light) => !isOn(light))
      .flatMap((light) => {
        const { device, capability } = light;
        const rule =
          device.roomId === null || !litRooms.has(device.roomId)
            ? undefined
            : rules.get(device.roomId);
        const state = rule?.get(keyOf(device.id, capability.id));
        if (state?.on === false) return [];
        const command: LightCommand = state
          ? { ...state }
          : rule
            ? { on: true }
            : withNothingToGoBy(light);
        return [{ light, command }];
      });
  }

  // The rooms a place covers, or none for the whole home and chosen
  // lights. A room, floor or zone the home does not have is refused rather
  // than taken for one with no lights.
  function roomsOf(place: LightsPlace): ReadonlySet<string> | null {
    if (place.kind === "home" || place.kind === "lights") return null;
    const rooms = roomsOfPlace(options.places.list(), place);
    if (!rooms) {
      throw new ActionCallError("not_found");
    }
    return new Set(rooms);
  }

  // The lights in a place that the view sees and a command can reach, or
  // every one the view sees there, offline too.
  function lightsIn(
    place: LightsPlace,
    view: View,
    withOffline = false,
  ): Light[] {
    const rooms = roomsOf(place);
    const chosen =
      place.kind === "lights"
        ? new Set(
            place.lights.map((light) => keyOf(light.device, light.capability)),
          )
        : null;
    return devices
      .list(view)
      .filter((device) => withOffline || device.availability !== "offline")
      .filter(
        (device) =>
          !rooms || (device.roomId !== null && rooms.has(device.roomId)),
      )
      .flatMap((device) =>
        device.capabilities
          .filter(
            (capability): capability is Light["capability"] =>
              capability.kind === "light" &&
              (!chosen || chosen.has(keyOf(device.id, capability.id))),
          )
          .map((capability) => ({ device, capability })),
      );
  }

  // Sends each light its command at once.
  async function sendAll(
    sending: readonly { light: Light; command: LightCommand }[],
    send: (light: Light, command: LightCommand) => Promise<unknown>,
  ) {
    const results = await Promise.allSettled(
      sending.map(({ light, command }) => send(light, command)),
    );
    return tally(
      results.map((result, index) => ({
        light: sending[index]!.light,
        result,
      })),
    );
  }

  // How many lights a call reached, and which failed. A light that went
  // meanwhile is not a failure; a refusal of whoever is behind the call
  // refuses it all.
  function tally(
    results: readonly { light: Light; result: PromiseSettledResult<unknown> }[],
  ) {
    let switched = 0;
    const failed: LightsResult["failed"] = [];
    for (const { light, result } of results) {
      if (result.status === "fulfilled") {
        switched += 1;
        continue;
      }
      const { reason } = result;
      if (reason instanceof ActionCallError) {
        if (reason.code === "not_found") continue;
        if (refusals.has(reason.code)) throw reason;
      }
      failed.push({ device: light.device.id, capability: light.capability.id });
    }
    return { switched, failed };
  }

  // Sends each light that is not there yet its command.
  async function switchWith(
    place: LightsPlace,
    to: LightsSwitch,
    view: View,
    send: (light: Light, command: LightCommand) => Promise<unknown>,
  ): Promise<LightsResult> {
    const lights = lightsIn(place, view);
    const on = to === "toggle" ? !lights.some(isOn) : to === "on";
    const off = lights.filter((light) => isOn(light) !== on);
    const switching = on
      ? turningOn(lights)
      : off.map((light) => ({ light, command: { on: false } }));
    return { on, ...(await sendAll(switching, send)) };
  }

  // Sets a place's lights together, as a room's Lights tile and its detail
  // do. A brightness adjusts the look the place has: while any light is on,
  // only those that are on change, so dimming a mood leaves the lights it
  // keeps off alone; while none is, the place comes on as its rooms' rules
  // say, at that level, and 0 turns them off. A colour or a white is the
  // look the place is to have, so every light takes it (colourWith).
  async function setWith(
    place: LightsPlace,
    set: LightsSet,
    view: View,
    send: (light: Light, command: LightCommand) => Promise<unknown>,
  ): Promise<LightsResult> {
    if (set.brightness === 0) {
      return switchWith(place, "off", view, send);
    }
    const lights = lightsIn(place, view);
    if (set.brightness === undefined) {
      return colourWith(lights, set, send);
    }
    const lit = lights.filter(isOn);
    const sending = lit.length
      ? lit.flatMap((light) => {
          const command = fieldsOf(light, set);
          return Object.keys(command).length ? [{ light, command }] : [];
        })
      : turningOn(lights).map(({ light, command }) => {
          const fields = fieldsOf(light, set);
          return { light, command: withSettings(command, fields) };
        });
    const result = await sendAll(sending, send);
    return { on: lit.length > 0 || result.switched > 0, ...result };
  }

  // What a light that is off comes on with when a colour or a white is
  // chosen for its place: the level of those that are on, on average, so
  // the place is even; while none is, the rule's look for the lights its
  // rules bring on and the level of those for the others, or as with
  // nothing to go by where the rules give none.
  function comingOnFor(lights: readonly Light[]) {
    const lit = lights.filter(isOn);
    const byRule = new Map(
      lit.length
        ? []
        : turningOn(lights).map(({ light, command }) => [light, command]),
    );
    const levels = (
      lit.length
        ? lit.filter(canDim).map((light) => light.capability.state?.brightness)
        : Array.from(byRule, ([{ capability }, command]) =>
            capability.features.brightness
              ? (command.brightness ??
                prepare(capability, command).send?.brightness ??
                capability.observed?.brightness)
              : undefined,
          )
    ).filter(
      (level): level is number => typeof level === "number" && level > 0,
    );
    const level = levels.length
      ? Math.round(levels.reduce((sum, each) => sum + each, 0) / levels.length)
      : undefined;
    return (light: Light): LightCommand =>
      byRule.get(light) ??
      (level === undefined
        ? withNothingToGoBy(light)
        : canDim(light)
          ? { on: true, brightness: level }
          : { on: true });
  }

  // A colour or a white for every light in a place, those that are off
  // included, even where a room's rule keeps them off: choosing the look
  // means the whole place in it. Each light that is off comes on as
  // comingOnFor says. A white brings on a fixed-white light and sets a
  // colour-only light to zero saturation. A colour leaves a light that
  // can't show it as it is.
  async function colourWith(
    lights: readonly Light[],
    set: Exclude<LightsSet, { brightness: number }>,
    send: (light: Light, command: LightCommand) => Promise<unknown>,
  ): Promise<LightsResult> {
    const comingOn = comingOnFor(lights);
    const sending = lights.flatMap((light) => {
      const fields = lookOf(light, set);
      const takes = Object.keys(fields).length > 0;
      if (isOn(light)) return takes ? [{ light, command: fields }] : [];
      if (!takes && set.colorTemperature === undefined) return [];
      return [{ light, command: withSettings(comingOn(light), fields) }];
    });
    const result = await sendAll(sending, send);
    return {
      on: lights.some(isOn) || result.switched > 0,
      ...result,
    };
  }

  // Steps each light that can dim one way, from the level last asked of it,
  // or where a remote's hold left it once it says so.
  async function stepWith(
    place: LightsPlace,
    to: "brighter" | "dimmer",
    view: View,
    send: (light: Light, command: LightCommand) => Promise<unknown>,
  ): Promise<LightsResult> {
    await options.holds.settle(lightsIn(place, view));
    const lights = lightsIn(place, view);
    const stepping = lights.filter(canDim).flatMap((light) => {
      const command = stepOf(light, to);
      return command ? [{ light, command }] : [];
    });
    const result = await sendAll(stepping, send);
    const on = lights.some(isOn) || (to === "brighter" && result.switched > 0);
    return { on, ...result };
  }

  // What an AI agent's ask does to each light in the place that answers: a
  // command, or why it's left alone.
  function planFor(lights: readonly Light[], ask: LightsAsk): Planned[] {
    if (ask.to === "off") {
      return lights.map((light) =>
        isOn(light)
          ? { light, command: { on: false } }
          : { light, why: "already" },
      );
    }
    if (ask.to === "brighter" || ask.to === "dimmer") {
      const to = ask.to;
      return lights.map((light) => {
        if (!canDim(light)) return { light, why: "no_brightness" };
        const command = stepOf(light, to);
        if (command) return { light, command };
        return {
          light,
          why: to === "dimmer" && !isOn(light) ? "off" : "already",
        };
      });
    }
    // Turning on and setting go by each room's rule for the lights that are
    // off, as its lights button does; one the rule keeps off stays off.
    const comingOn = new Map(
      turningOn(lights).map(({ light, command }) => [
        keyOf(light.device.id, light.capability.id),
        command,
      ]),
    );
    const ruleFor = (light: Light) =>
      comingOn.get(keyOf(light.device.id, light.capability.id));
    if (ask.to === "on") {
      return lights.map((light) => {
        if (isOn(light)) return { light, why: "already" };
        const command = ruleFor(light);
        return command ? { light, command } : { light, why: "kept_off" };
      });
    }
    // A set does as on a room's Lights tile. A colour or a white is the
    // look the place is to have: every light that is off comes on with it,
    // those its room's rule keeps off too, at the level asked or as
    // comingOnFor says. A brightness alone adjusts the look the place has:
    // while any light is on, only those change; while none is, the place
    // comes on by its rooms' rules at it.
    const set = ask.set!;
    const look =
      set.colorTemperature !== undefined || set.hue !== undefined
        ? comingOnFor(lights)
        : undefined;
    const anyOn = lights.some(isOn);
    return lights.map((light): Planned => {
      const fields = lookOf(light, set);
      const ignored = (
        [
          ["brightness", set.brightness, fields.brightness],
          [
            "colorTemperature",
            set.colorTemperature,
            fields.colorTemperature ?? fields.saturation,
          ],
          ["color", set.hue, fields.hue],
        ] as const
      ).flatMap(([field, asked, taken]) =>
        asked !== undefined && taken === undefined ? [field] : [],
      );
      const partly = ignored.length > 0 ? { ignored } : {};
      const takes = Object.keys(fields).length > 0;
      // A light that's on gets only what was asked, so a mood's colour
      // stays when only its brightness was.
      if (isOn(light)) {
        return takes
          ? { light, command: fields, ...partly }
          : { light, why: "unsupported", ignored };
      }
      if (look) {
        // A white brings on a light that has none of its own; a colour
        // leaves one that can't show it off, whatever level comes with it.
        if (set.hue !== undefined && fields.hue === undefined) {
          return { light, why: "unsupported", ignored };
        }
        return {
          light,
          command: withSettings(look(light), fields),
          ...partly,
        };
      }
      if (anyOn) return { light, why: "off" };
      const rule = ruleFor(light);
      if (!rule) return { light, why: "kept_off" };
      return { light, command: withSettings(rule, fields), ...partly };
    });
  }

  return {
    // An AI agent's ask of a place's lights: on, off, brighter, dimmer, or a
    // brightness, a white or a colour set within each light's range, as a
    // room's Lights tile sets them (planFor). The gate admits the agent as
    // for any household write, and again for each light's command. Every
    // light the agent may see there is answered for: as sent or confirmed,
    // with what it asked and how the light was before, so the agent's
    // change can be put back; or left alone, and why; or offline.
    async changeFor(
      agent: AgentCaller,
      place: LightsPlace,
      ask: LightsAsk,
      view: View,
    ): Promise<LightOutcome[]> {
      const rule = deviceCommandRule("light");
      const actor = gate.admit(agent, rule);
      if (ask.to === "brighter" || ask.to === "dimmer") {
        const lights = lightsIn(place, view);
        if (
          actor.kind === "assistant-run" &&
          lights.some(({ device, capability }) =>
            options.holds.isMoving(device.id, capability.id),
          )
        ) {
          options.checkAgentCommand(actor.id, false);
        }
        await options.holds.settle(lights);
        gate.permit(actor, rule);
      }
      const every = lightsIn(place, view, true);
      const offline = every.filter(
        (light) => light.device.availability === "offline",
      );
      const planned = planFor(
        every.filter((light) => light.device.availability !== "offline"),
        ask,
      );
      const outcomes = await Promise.all(
        planned.map(
          async ({ light, command, why, ignored }): Promise<LightOutcome> => {
            const address = {
              device: light.device.id,
              capability: light.capability.id,
              name: light.device.name,
              ...(ignored ? { ignored } : {}),
            };
            if (!command) {
              return {
                ...address,
                result: "skipped",
                why,
                state: light.capability.state,
              };
            }
            let change: CommandChange | undefined;
            let isConfirmed = false;
            try {
              const after = await devices.commandFor(
                agent,
                {
                  device: address.device,
                  capability: address.capability,
                  command,
                },
                {
                  accepted: (commandChange, confirmed) => {
                    change = commandChange;
                    isConfirmed = confirmed;
                  },
                },
              );
              return {
                ...address,
                result: isConfirmed ? "confirmed" : "sent",
                change,
                state: after.kind === "light" ? after.state : null,
              };
            } catch (error) {
              return {
                ...address,
                result: "failed",
                why: error instanceof ActionCallError ? error.code : "failed",
                state: light.capability.state,
              };
            }
          },
        ),
      );
      for (const light of offline) {
        outcomes.push({
          device: light.device.id,
          capability: light.capability.id,
          name: light.device.name,
          result: "offline",
          state: light.capability.state,
        });
      }
      return outcomes;
    },

    // A client's button: the gate admits the principal behind it as for
    // any household write, and again for each light's command.
    async switchFor(principal: Principal, input: unknown) {
      const parsed = request.safeParse(input);
      if (!parsed.success) {
        throw new ActionCallError("invalid_request");
      }
      gate.admit(principal, { tier: "write" });
      const send = (light: Light, command: LightCommand) =>
        devices.commandFor(principal, {
          device: light.device.id,
          capability: light.capability.id,
          command,
        });
      const { data } = parsed;
      return "set" in data
        ? setWith(data.place, data.set, {}, send)
        : switchWith(data.place, data.to, {}, send);
    },

    // A workflow's step, as the workflow; no app sent it. Brightening or
    // dimming while held follows the remote's press that ran the workflow.
    async switch(
      actor: Actor,
      input: { place: LightsPlace; to: LightsChange },
      view: View,
      press?: Remote,
    ): Promise<LightsResult> {
      const send = (light: Light, command: LightCommand) =>
        devices.command(
          actor,
          {
            device: light.device.id,
            capability: light.capability.id,
            command,
          },
          view,
          null,
        );
      const { place, to } = input;
      if (to === "brighter" || to === "dimmer") {
        return stepWith(place, to, view, send);
      }
      const direction = held[to];
      if (!direction) {
        return switchWith(place, to as LightsSwitch, view, send);
      }
      if (!press) {
        throw new Error(
          "Nothing is held: only a remote's press can brighten or dim lights while held",
        );
      }
      const { moved, failed, on } = await options.holds.start(
        actor,
        press,
        lightsIn(place, view),
        direction,
        view,
      );
      return {
        on,
        ...tally([
          ...moved.map((light) => ({
            light,
            result: { status: "fulfilled", value: undefined } as const,
          })),
          ...failed.map(({ light, reason }) => ({
            light,
            result: { status: "rejected", reason } as const,
          })),
        ]),
      };
    },

    // A workflow's condition: whether any light in a place is on, or all
    // are off.
    are(input: { place: LightsPlace; are: "anyOn" | "allOff" }, view: View) {
      const anyOn = lightsIn(input.place, view).some(isOn);
      return input.are === "anyOn" ? anyOn : !anyOn;
    },
  };
}

export type Lights = ReturnType<typeof createLights>;
