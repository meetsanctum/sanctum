import {
  choice,
  names,
  partOf,
  turnOnSchema,
  turnOnType,
  type Actor,
  type CapabilityInfo,
  type DeviceInfo,
  type LightCommand,
  type LightsChange,
  type LightsPlace,
  type LightsResult,
  type LightsSwitch,
  type TurnOnLight,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import { ActionCallError } from "../app-host/errors.js";
import type { Gate } from "../app-host/gate.js";
import type { Principal } from "../auth/clients.js";
import type { Entities } from "../entities/entities.js";
import type { PlacesModule } from "../places/places.js";
import type { Devices } from "./devices.js";
import type { HoldDirection, Holds, Remote } from "./holds.js";
import type { View } from "./views.js";

// The lights of a room, a zone or the whole home together: a room's and
// Lights' button, and the lights condition and step of workflows, so they
// work with no lighting app. Toggling turns them all off while any is on,
// and on otherwise. A light that is offline is left alone and does not
// count, and "all off" means none is on: a light that has yet to report
// counts as not on. Each light's command passes the gate as the caller,
// like any other. What turning a room on brings is an app's rule, such as
// Moods' scheduled mood or what the room was before it went dark: the app
// publishes it as the room's lights.turnOn entity, which the core reads by
// type here, so no app code runs at the press. A zone or the home go room
// by room. Without one, a light comes back as the core remembers it. A
// workflow whose place is a room or a zone that was removed is broken.
// Chosen lights are a place of their own, and a workflow with one of them
// removed is broken too. The step also makes lights brighter or dimmer by a
// fifth of their range, and brightens or dims them while the remote's
// button that ran it is held (holds.ts); lights that cannot dim are left
// alone by both.

// A place's schema says `place`, so Automations' editor offers one picker
// for the room, the zone or the home rather than a field for each part.
export const lightsPlace = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("room"), id: names("room") }),
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

/** How far Brighter and Dimmer step a light, of its whole range. */
export const lightsStepPercent = 20;
// The short fade of a step, as Hue's dimmer steps.
const stepSeconds = 0.4;

const held: Partial<Record<LightsChange, HoldDirection>> = {
  brightenWhileHeld: "up",
  dimWhileHeld: "down",
  brightenOrDimWhileHeld: "turns",
};

export const lightsAre = choice({
  anyOn: "any light is on",
  allOff: "every light is off",
});

const request = z.strictObject({ place: lightsPlace, to: lightsSwitch });

type Light = {
  device: DeviceInfo;
  capability: Extract<CapabilityInfo, { kind: "light" }>;
};

// Refusals for whoever is behind the call, which refuse the whole call
// rather than fail one light.
const refusals = new Set(["forbidden", "needs_approval"]);

const isOn = (light: Light) => light.capability.state?.on === true;

const canDim = (light: Light) =>
  light.capability.kind === "light" && light.capability.features.brightness;

// What a step asks of a light: brighter from off as from nothing, dimmer
// down to the lowest but never off, and nothing where it is at that end.
function stepOf(
  { capability }: Light,
  to: "brighter" | "dimmer",
): LightCommand | null {
  if (capability.kind !== "light") return null;
  const isLit = capability.state?.on === true;
  if (to === "dimmer" && !isLit) return null;
  const level = isLit ? (capability.state?.brightness ?? 100) : 0;
  const brightness =
    to === "brighter"
      ? Math.min(100, level + lightsStepPercent)
      : Math.max(1, level - lightsStepPercent);
  return brightness === level
    ? null
    : { brightness, transitionSeconds: stepSeconds };
}

const keyOf = (device: string, capability: string) => `${device}/${capability}`;

export function createLights(options: {
  devices: Pick<Devices, "list" | "command" | "commandFor">;
  places: Pick<PlacesModule, "list">;
  gate: Gate;
  entities: Pick<Entities, "list">;
  holds: Pick<Holds, "start" | "settle">;
  now?: () => Date;
}) {
  const { devices, gate } = options;
  const now = options.now ?? (() => new Date());

  // What turning each room on does for its lights: the lights.turnOn of
  // the first app that provides one for the room, while it holds.
  function turnOnRules() {
    const at = now().getTime();
    const rules = new Map<string, Map<string, TurnOnLight["state"]>>();
    for (const entity of options.entities.list({
      type: turnOnType.id,
    })) {
      const parsed = turnOnSchema.safeParse(entity.state);
      if (!parsed.success) continue;
      const { placeId, lights, until } = parsed.data;
      if (rules.has(placeId)) continue;
      if (until !== null && Date.parse(until) <= at) continue;
      rules.set(
        placeId,
        new Map(
          lights.map((light) => [
            keyOf(light.device, light.capability),
            light.state,
          ]),
        ),
      );
    }
    return rules;
  }

  // The commands that turn a place's lights on, room by room: each light
  // that is off as its room's rule says, where it names the light. A room
  // with none of its lights on whose rule would leave them all off is
  // switched on as if it had none, since on never means nothing comes on:
  // its lights come back as the core remembers them. A room with a light
  // on already keeps the lights its rule keeps off.
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
        const state =
          device.roomId === null || !litRooms.has(device.roomId)
            ? undefined
            : rules.get(device.roomId)?.get(keyOf(device.id, capability.id));
        if (state?.on === false) return [];
        const command: LightCommand = state ? { ...state } : { on: true };
        return [{ light, command }];
      });
  }

  // The rooms a place covers, or none for the whole home and chosen
  // lights. A room or zone the home does not have is refused rather than
  // taken for one with no lights.
  function roomsOf(place: LightsPlace): ReadonlySet<string> | null {
    if (place.kind === "home" || place.kind === "lights") return null;
    const places = options.places.list();
    const rooms =
      place.kind === "room"
        ? places.rooms.some((room) => room.id === place.id) && [place.id]
        : places.zones.find((zone) => zone.id === place.id)?.roomIds;
    if (!rooms) {
      throw new ActionCallError("not_found");
    }
    return new Set(rooms);
  }

  // The lights in a place that the view sees and a command can reach.
  function lightsIn(place: LightsPlace, view: View): Light[] {
    const rooms = roomsOf(place);
    const chosen =
      place.kind === "lights"
        ? new Set(
            place.lights.map((light) => keyOf(light.device, light.capability)),
          )
        : null;
    return devices
      .list(view)
      .filter((device) => device.availability !== "offline")
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

  return {
    // A client's button: the gate admits the principal behind it as for
    // any household write, and again for each light's command.
    async switchFor(principal: Principal, input: unknown) {
      const parsed = request.safeParse(input);
      if (!parsed.success) {
        throw new ActionCallError("invalid_request");
      }
      gate.admit(principal, { tier: "write" });
      const { place, to } = parsed.data;
      return switchWith(place, to, {}, (light, command) =>
        devices.commandFor(principal, {
          device: light.device.id,
          capability: light.capability.id,
          command,
        }),
      );
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
