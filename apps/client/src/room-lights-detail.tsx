import type {
  CapabilityInfo,
  LightFeatures,
  LightState,
} from "@meetsanctum/app-sdk";
import {
  icons,
  LightControls,
  PowerButton,
  type SwipePage,
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
// are a light's controls where any of the room's lights has them: its
// colour and white, with the button that turns them all on or off, and its
// brightness; a room whose lights only dim has the power button as a page
// of its own after its brightness. It shows the lights that are on, their
// level on average and the colour of the first, and sets them together
// through the room's Lights tile's calls (room-lights.tsx): every light
// that is on takes what it can of a colour, a white or a level, and while
// none is on the room comes on at it. It has no history or activity of its
// own, which each light's detail keeps. A room removed meanwhile, or left
// without lights, closes it.

type Light = Extract<CapabilityInfo, { kind: "light" }>;

// What the room's lights can do between them: a level where any dims, the
// whites from the warmest to the coolest any takes, and colour where any
// has it.
function featuresOf(lights: readonly Light[]): LightFeatures {
  const ranges = lights.flatMap((light) =>
    light.features.colorTemperature ? [light.features.colorTemperature] : [],
  );
  return {
    brightness: lights.some((light) => light.features.brightness),
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

// How the room's lights look together: on while any is on, at their level
// on average, in the colour or white of the first that is on.
function stateOf(lights: readonly Light[], level: number | undefined) {
  const lit = lights.filter((light) => light.state?.on === true);
  const first = lit[0]?.state ?? lights[0]?.state;
  const { colorMode, colorTemperature, hue, saturation } = first ?? {};
  return {
    on: lit.length > 0,
    ...(level !== undefined ? { brightness: level } : {}),
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
  const shown = new Set(
    tiles.filter((each) => !each.disabled).map((each) => each.key),
  );
  const capabilities = devices.devices.flatMap((device) =>
    device.capabilities.flatMap((capability) =>
      capability.kind === "light" &&
      tiles.some((each) => each.key === tileKey(device.id, capability.id))
        ? [{ capability, online: shown.has(tileKey(device.id, capability.id)) }]
        : [],
    ),
  );
  // What those that answer can do, or all of them while none answers.
  const online = capabilities.filter((each) => each.online);
  const lights = (online.length > 0 ? online : capabilities).map(
    (each) => each.capability,
  );
  const features = featuresOf(lights);
  const state = stateOf(lights, tile?.brightness);
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
          disabled={disabled}
          failures={tile.failures}
          onCommand={(asked) => command(roomId, asked)}
          pages={power}
        />
      )}
    </Overlay>
  );
}
