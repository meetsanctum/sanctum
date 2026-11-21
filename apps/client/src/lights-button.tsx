import type { Floor } from "@meetsanctum/app-sdk";
import { Button, icons, type Tile } from "@meetsanctum/ui-sdk";

import type { Devices } from "./use-devices";

// The button for all the lights of a room or a floor: a chip of frosted
// glass, half a tile high, with the power symbol and its words, "Turn off
// lights" while any light is on and "Turn on lights" while all are off. It
// is White while any is on, by its own state and not as a pressed switch,
// since its words already say what it does. A room's is under its name and
// its line, above its row's moods, on Home and its page, and above its
// lights on Lights' page; a floor's is under the floor's name. Its
// accessible name adds whose lights they are, "Turn off lights in
// Kitchen", since several are in reach at once. A floor's only turns its
// lights off: its rooms come on one by one, each by its own button, so
// while none is on it stays, disabled, and nothing moves. The core leaves
// offline lights alone, so while all of them are offline it is disabled,
// as their tiles are. It sends the core the way its words say, off or on,
// and no toggle, so a screen a moment behind never does the opposite.

const onCount = (tiles: readonly Tile[]) =>
  tiles.filter((tile) => tile.on && !tile.disabled).length;

/** A place's button for all its lights, as lightsButton makes it. */
export type LightsSwitch = {
  on: number;
  /** What it shows: "Turn off lights" or "Turn on lights". */
  words: string;
  /** Its words with whose lights they are, its accessible name. */
  label: string;
  disabled?: boolean;
  onToggle: () => void;
};

/** A room's or a floor's button for all its lights. */
export function LightsButton(props: { lights: LightsSwitch }) {
  const { lights } = props;
  return (
    <Button
      variant="glass"
      size="chip"
      aria-label={lights.label}
      data-on={lights.on > 0 ? "" : undefined}
      disabled={lights.disabled}
      onClick={lights.onToggle}
      className="self-start"
    >
      <icons.Power aria-hidden="true" data-icon="inline-start" />
      {lights.words}
    </Button>
  );
}

// A room's button: off while any light is on, on otherwise.
export function lightsButton(
  lights: Tile[],
  room: { id: string; name: string },
  devices: Devices,
): LightsSwitch | undefined {
  if (lights.length === 0) return undefined;
  const on = onCount(lights);
  const words = on > 0 ? "Turn off lights" : "Turn on lights";
  return {
    on,
    words,
    label: `${words} in ${room.name}`,
    disabled: lights.every((tile) => tile.disabled),
    onToggle: () =>
      void devices
        .switchLights(
          { kind: "room", id: room.id },
          lights,
          on > 0 ? "off" : "on",
        )
        .catch(() => undefined),
  };
}

// A floor's button, which only turns its lights off.
export function floorLightsButton(
  lights: Tile[],
  floor: Floor,
  devices: Devices,
): LightsSwitch | undefined {
  if (lights.length === 0) return undefined;
  const on = onCount(lights);
  return {
    on,
    words: "Turn off lights",
    label: `Turn off lights on ${floor.name}`,
    disabled: on === 0,
    onToggle: () =>
      void devices
        .switchLights({ kind: "floor", id: floor.id }, lights, "off")
        .catch(() => undefined),
  };
}
