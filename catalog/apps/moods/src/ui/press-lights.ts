import type { DeviceInfo, Places } from "@meetsanctum/app-sdk";

import type { PressPlace } from "../presses/presses.js";

// The lights a press can be for, on its Which lights page: ported from v1's
// light picker for button bindings (buildButtonLightOptions,
// groupLightOptions and targetKey, button-actions.ts, Pragmata v1-final),
// which offered the lights by room and kept a choice of them each once and
// in a stable order.

export type ChosenLight = { device: string; capability: string };

/** A light as the picker lists it. */
export type LightOption = ChosenLight & {
  name: string;
  /** How it is now, such as "On · 80%", "Off" or "Offline". */
  detail: string;
  /** Whether it can dim, which brightening and dimming need. */
  canDim: boolean;
};

export type LightGroup = { id: string; name: string; lights: LightOption[] };

export const lightKey = (light: ChosenLight) =>
  `${light.device}/${light.capability}`;

/** Chosen lights each once, in a stable order, as v1's targetKey kept them. */
export function chosenLights(lights: Iterable<ChosenLight>): ChosenLight[] {
  const byKey = new Map<string, ChosenLight>();
  for (const light of lights) {
    byKey.set(lightKey(light), {
      device: light.device,
      capability: light.capability,
    });
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, light]) => light);
}

function detailOf(device: DeviceInfo, state: unknown, canDim: boolean) {
  if (device.availability === "offline") return "Offline";
  const shown = state as { on?: boolean; brightness?: number } | null;
  const now =
    shown?.on === true
      ? canDim && shown.brightness !== undefined
        ? `On · ${shown.brightness}%`
        : "On"
      : "Off";
  return canDim ? now : `${now} · Can't dim`;
}

/** Every light Moods sees, each with how it is now. */
export function lightOptions(devices: readonly DeviceInfo[]): LightOption[] {
  return devices.flatMap((device) =>
    device.capabilities.flatMap((capability) => {
      if (capability.kind !== "light") return [];
      const canDim = capability.features.brightness;
      const several =
        device.capabilities.filter((each) => each.kind === "light").length > 1;
      return [
        {
          device: device.id,
          capability: capability.id,
          name: several ? `${device.name} ${capability.id}` : device.name,
          detail: detailOf(device, capability.state, canDim),
          canDim,
        },
      ];
    }),
  );
}

/**
 * The lights by room, each by name: the remote's room first, then the
 * home's other rooms in order, then those in no room (v1's
 * groupLightOptions).
 */
export function lightGroups(
  devices: readonly DeviceInfo[],
  places: Places | undefined,
  firstRoomId: string | null,
): LightGroup[] {
  const roomOf = new Map(devices.map((device) => [device.id, device.roomId]));
  const rooms = [...(places?.rooms ?? [])].sort(
    (a, b) => Number(b.id === firstRoomId) - Number(a.id === firstRoomId),
  );
  const options = lightOptions(devices).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const groups = rooms.map((room) => ({
    id: room.id,
    name: room.name,
    lights: options.filter((light) => roomOf.get(light.device) === room.id),
  }));
  const known = new Set(rooms.map((room) => room.id));
  groups.push({
    id: "none",
    name: "No room",
    lights: options.filter((light) => {
      const room = roomOf.get(light.device);
      return room === null || room === undefined || !known.has(room);
    }),
  });
  return groups.filter((group) => group.lights.length > 0);
}

/** The lights a place has, as Some lights starts from it. */
export function lightsOf(
  place: PressPlace,
  devices: readonly DeviceInfo[],
  places: Places | undefined,
): ChosenLight[] {
  if (place.kind === "lights") return chosenLights(place.lights);
  const rooms =
    place.kind === "home"
      ? null
      : new Set(
          place.kind === "room"
            ? [place.id]
            : (places?.zones.find((zone) => zone.id === place.id)?.roomIds ??
                []),
        );
  return chosenLights(
    lightOptions(
      devices.filter(
        (device) =>
          !rooms || (device.roomId !== null && rooms.has(device.roomId)),
      ),
    ),
  );
}
