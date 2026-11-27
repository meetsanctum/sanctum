import type { CapabilityInfo, LightState } from "@meetsanctum/app-sdk";
import {
  icons,
  LightControls,
  PowerButton,
  type SwipePage,
  type Tile,
} from "@meetsanctum/ui-sdk";
import { useEffect } from "react";

import { tileKey } from "./device-tiles";
import { Overlay } from "./overlay";
import {
  roomLightsKey,
  roomLightsLabel,
  roomLightsTile,
  useRoomLights,
} from "./room-lights";
import type { Devices } from "./use-devices";

// A room's Lights tile's detail: a light's detail for all the room's lights
// at once, opened from the tile as a light's is from its own. Its header
// says "Lights" and the room with how many are on, beside Done. Its pages
// show Colour and White according to what the reachable lights support,
// with disabled controls for the room's lights when they are all offline.
// Brightness follows the lit lights while any are on and the reachable
// lights when the room is off. A room whose lights only dim has the power
// button as a page of its own after Brightness. It shows the average level
// and first reported colour and white of the lights that are on. It sets
// them through the room's Lights tile. Colour and White also reach lights
// that are off. Brightness adjusts lit lights or brings up a dark room. It
// has no history or activity of its own, which each light's detail keeps.
// A room removed meanwhile, or left without lights, closes it.

type Light = Extract<CapabilityInfo, { kind: "light" }>;

// The whites from the warmest to the coolest any light takes, and colour
// where any light has it.
function appearanceOf(lights: readonly Light[]) {
  const ranges = lights.flatMap((light) =>
    light.features.colorTemperature ? [light.features.colorTemperature] : [],
  );
  return {
    colorTemperature:
      ranges.length > 0
        ? {
            min: Math.min(...ranges.map((range) => range.min)),
            max: Math.max(...ranges.map((range) => range.max)),
          }
        : null,
    color: lights.some((light) => light.features.color),
  };
}

// The first reported colour and white among the lights shown in the controls.
function stateOf(lights: readonly Light[], tile: Tile | undefined) {
  let colorMode: LightState["colorMode"];
  let colorTemperature: number | undefined;
  let hue: number | undefined;
  let saturation: number | undefined;
  for (const { state, features } of lights) {
    if (!state) continue;
    if (
      hue === undefined &&
      features.color &&
      state.colorMode !== "temperature" &&
      state.hue !== undefined &&
      state.saturation !== undefined
    ) {
      ({ hue, saturation } = state);
      colorMode ??= "color";
    }
    if (
      colorTemperature === undefined &&
      features.colorTemperature &&
      state.colorMode !== "color"
    ) {
      colorTemperature = state.colorTemperature;
      if (colorTemperature !== undefined) colorMode ??= "temperature";
    }
  }
  return {
    on: tile?.on ?? false,
    brightness: tile?.brightness,
    ...(colorMode ? { colorMode } : {}),
    ...(colorTemperature !== undefined ? { colorTemperature } : {}),
    ...(hue !== undefined && saturation !== undefined
      ? { hue, saturation }
      : {}),
  } satisfies LightState;
}

export function RoomLightsDetail(props: {
  container: HTMLElement | null;
  roomId: string;
  open: boolean;
  onClose: () => void;
  onCovering: (covering: boolean) => void;
  devices: Devices;
}) {
  const { devices, roomId, onClose } = props;
  const { command } = useRoomLights(devices);
  const room = devices.places?.rooms.find((each) => each.id === roomId);
  const tiles = devices.tiles.filter(
    (tile) => tile.kind === "light" && tile.roomId === roomId,
  );
  const tile = roomLightsTile(
    tiles,
    roomId,
    devices.failures.get(roomLightsKey(roomId)),
  );
  // The lights a colour or a white reaches: every one a command can, or,
  // while all are offline, every one, so their controls show disabled.
  const reachable = new Map(
    tiles
      .filter((each) => tile?.disabled || !each.disabled)
      .map((each) => [each.key, each]),
  );
  const lights: Light[] = [];
  const lit: Light[] = [];
  for (const device of devices.devices) {
    if (device.roomId !== roomId) continue;
    for (const capability of device.capabilities) {
      if (capability.kind !== "light") continue;
      const lightTile = reachable.get(tileKey(device.id, capability.id));
      if (!lightTile) continue;
      lights.push(capability);
      if (lightTile.on) lit.push(capability);
    }
  }
  const features = {
    ...appearanceOf(lights),
    brightness: tile?.disabled
      ? lights.some((light) => light.features.brightness)
      : (tile?.dims ?? false),
  };
  const state = stateOf(tile?.on ? lit : lights, tile);
  // A room removed meanwhile, or without lights now, closes its detail.
  const gone = props.open && devices.places !== undefined && (!room || !tile);
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);

  const name = roomLightsLabel(room?.name ?? "");
  const disabled = tile?.disabled ?? true;
  // A light with a colour or a white turns on and off on that page; one
  // that only dims has nothing but its level, so the room's lights get
  // their power button as a page of its own.
  const power: SwipePage[] =
    features.brightness && !features.color && !features.colorTemperature
      ? [
          {
            id: "power",
            label: "Power",
            icon: icons.Power,
            muted: disabled,
            content: (
              <PowerButton
                name={name}
                on={state.on}
                disabled={disabled}
                onToggle={() => command(roomId, { on: !state.on })}
              />
            ),
          },
        ]
      : [];
  return (
    <Overlay
      container={props.container}
      open={props.open && room !== undefined && tile !== undefined}
      onClose={onClose}
      onCovering={props.onCovering}
      title="Lights"
      subtitle={room && tile && `${room.name} · ${tile.status}`}
    >
      {room && tile && (
        <LightControls
          key={roomLightsKey(roomId)}
          name={name}
          features={features}
          state={state}
          mixedAppearance
          disabled={disabled}
          failures={tile.failures}
          onCommand={(asked) => command(roomId, asked)}
          pages={power}
        />
      )}
    </Overlay>
  );
}
