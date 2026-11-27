import type { LightCommand, LightsSwitch } from "@meetsanctum/app-sdk";
import { DeviceTile, icons, lightColour, type Tile } from "@meetsanctum/ui-sdk";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";

import { supportsBrightness } from "./device-tiles";
import { useLightsPress } from "./lights-button";
import { sameData } from "./same-data";
import type { Devices } from "./use-devices";

// A room's Lights tile: every light in the room as one, first among the
// room's lights wherever they show: first under Devices on Home, first under
// Lights on its page and first among its lights on Lights' page. It is drawn
// as a light's tile with the power symbol, lit while any light is on, in
// their colour when they share one and warm white otherwise, its lit part
// the level of those that are on. Its round icon turns them all off while
// any is on, and the room on by its rule while none is; a drag across sets
// every light that is on to its level, or brings the room up at it; the rest
// opens its detail (room-lights-detail.tsx). It says how many are on and at
// what level ("3 on · 60%", "2 of 3 on · 80%"), and is disabled while every
// light is offline, as their tiles are. A press that reaches no light shows
// its failure on it, as a light's own does.

const prefix = "room-lights:";

/** The key of a room's Lights tile, which opens its detail too. */
export const roomLightsKey = (roomId: string) => `${prefix}${roomId}`;

/** The room whose Lights tile has this key, or null for any other tile. */
export const roomOfLightsKey = (key: string | null) =>
  key?.startsWith(prefix) ? key.slice(prefix.length) : null;

/** What screen readers call a room's Lights tile and its detail. */
export const roomLightsLabel = (roomName: string) => `Lights in ${roomName}`;

// The level of the lights that are on and dim, on average.
function levelOf(lit: readonly Tile[]) {
  const levels = lit.flatMap((tile) =>
    tile.dims && tile.brightness !== undefined ? [tile.brightness] : [],
  );
  return levels.length > 0
    ? Math.round(levels.reduce((sum, level) => sum + level, 0) / levels.length)
    : undefined;
}

// What it says: how many are on, of how many, and at what level.
function statusOf(
  reachable: readonly Tile[],
  lit: readonly Tile[],
  level: number | undefined,
) {
  if (reachable.length === 0) return "Offline";
  if (lit.length === 0) return "Off";
  const at = level === undefined ? "" : `${level}%`;
  if (reachable.length === 1) return at || "On";
  const on =
    lit.length === reachable.length
      ? `${lit.length} on`
      : `${lit.length} of ${reachable.length} on`;
  return at ? `${on} · ${at}` : on;
}

/** A room's Lights tile, or none for a room without lights. */
export function roomLightsTile(
  lights: readonly Tile[],
  roomId: string,
  failures?: number,
): Tile | undefined {
  if (lights.length === 0) return undefined;
  const reachable = lights.filter((tile) => !tile.disabled);
  const lit = reachable.filter((tile) => tile.on);
  const level = levelOf(lit);
  const colours = new Set(lit.map((tile) => tile.colour));
  const isOn = lit.length > 0;
  return {
    key: roomLightsKey(roomId),
    deviceId: "",
    capabilityId: "",
    kind: "light",
    roomId,
    name: "Lights",
    status: statusOf(reachable, lit, level),
    on: isOn,
    look: isOn ? "lit" : "off",
    ...(isOn
      ? {
          colour:
            colours.size === 1 && lit[0]!.colour
              ? lit[0]!.colour
              : lightColour({ on: true }),
        }
      : {}),
    dims: (isOn ? lit : reachable).some(supportsBrightness),
    ...(level !== undefined ? { brightness: level } : {}),
    disabled: reachable.length === 0,
    ...(failures ? { failures } : {}),
  };
}

type RoomLightsDevices = Pick<Devices, "tiles" | "switchLights" | "setLights">;

/**
 * What a room's Lights tile and its detail ask of the room's lights, the
 * same functions each time, reading the latest lights when they are called.
 * A press that reaches no light, or fails as a whole, fails the tile.
 */
export function useRoomLights(devices: RoomLightsDevices) {
  const latest = useRef(devices);
  useLayoutEffect(() => {
    latest.current = devices;
  });

  const command = useCallback((roomId: string, asked: LightCommand) => {
    const { tiles, switchLights, setLights } = latest.current;
    const lights = tiles.filter(
      (tile) => tile.kind === "light" && tile.roomId === roomId,
    );
    const place = { kind: "room", id: roomId } as const;
    const key = roomLightsKey(roomId);
    // A colour or a white goes with any on it carries; a level on its own.
    const sending =
      asked.hue !== undefined && asked.saturation !== undefined
        ? setLights(
            place,
            lights,
            {
              hue: asked.hue,
              saturation: asked.saturation,
            },
            key,
          )
        : asked.colorTemperature !== undefined
          ? setLights(
              place,
              lights,
              {
                colorTemperature: asked.colorTemperature,
              },
              key,
            )
          : asked.brightness !== undefined
            ? setLights(place, lights, { brightness: asked.brightness }, key)
            : switchLights(
                place,
                lights,
                asked.on === false ? "off" : "on",
                key,
              );
    void sending.catch(() => undefined);
  }, []);

  // The tile's round icon, which shows its own failures (useLightsPress).
  const switchRoom = useCallback(
    (roomId: string, to: Exclude<LightsSwitch, "toggle">) => {
      const { tiles, switchLights } = latest.current;
      return switchLights(
        { kind: "room", id: roomId },
        tiles.filter((tile) => tile.kind === "light" && tile.roomId === roomId),
        to,
      );
    },
    [],
  );
  const onDim = useCallback(
    (tile: Tile, brightness: number) => command(tile.roomId!, { brightness }),
    [command],
  );
  return useMemo(
    () => ({ command, switchRoom, onDim }),
    [command, switchRoom, onDim],
  );
}

export type RoomLights = ReturnType<typeof useRoomLights>;

/**
 * A room's Lights tile, on the grid as a light's tile is. Its round icon
 * presses as a floor's button does (lights-button.tsx): turning on, it is
 * lit from the press until a light is on. It keeps its tile while what it
 * says is the same, so a change to one of the room's other tiles doesn't
 * draw it again.
 */
export function RoomLightsTile(props: {
  tile: Tile;
  roomName: string;
  lights: RoomLights;
  onOpen: (tile: Tile) => void;
}) {
  const { roomId } = props.tile;
  const { switchRoom } = props.lights;
  const pressing = useLightsPress({
    isOn: props.tile.on,
    where: `in ${props.roomName}`,
    isDisabled: props.tile.disabled,
    switchLights: (to) => switchRoom(roomId!, to),
  });
  const latestPress = useRef(pressing.press);
  useLayoutEffect(() => {
    latestPress.current = pressing.press;
  });
  const onToggle = useCallback(() => latestPress.current(), []);
  let tile = props.tile;
  if (pressing.isOn && !tile.on) {
    tile = {
      ...tile,
      on: true,
      look: "lit",
      colour: lightColour({ on: true }),
      status: "On",
    };
  }
  if (pressing.failures > 0) {
    tile = { ...tile, failures: (tile.failures ?? 0) + pressing.failures };
  }
  const kept = useRef(tile);
  if (kept.current !== tile && !sameData(kept.current, tile)) {
    kept.current = tile;
  }
  return (
    <DeviceTile
      tile={kept.current}
      icon={icons.Power}
      label={roomLightsLabel(props.roomName)}
      onToggle={onToggle}
      onDim={props.lights.onDim}
      onOpen={props.onOpen}
    />
  );
}

// A room's Lights tile, as its lights stand.
export function LightsTileOf(props: {
  lights: readonly Tile[];
  room: { id: string; name: string };
  devices: Pick<Devices, "failures">;
  roomLights: RoomLights;
  onOpen: (tile: Tile) => void;
}) {
  const { room } = props;
  const tile = roomLightsTile(
    props.lights,
    room.id,
    props.devices.failures.get(roomLightsKey(room.id)),
  );
  return tile ? (
    <RoomLightsTile
      key={tile.key}
      tile={tile}
      roomName={room.name}
      lights={props.roomLights}
      onOpen={props.onOpen}
    />
  ) : null;
}
