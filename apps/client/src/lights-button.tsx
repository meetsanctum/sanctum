import type { Floor } from "@meetsanctum/app-sdk";
import { Button, icons, type Tile } from "@meetsanctum/ui-sdk";

import type { Devices } from "./use-devices";

// The switch for all the lights of a room or a floor. Its words say what it
// does, "Turn off" while any light is on and "Turn on" while all are off,
// and its look says how the place is, White while any is on, so it is no
// pressed switch to a screen reader: the words already say it. It shows the
// power symbol alone, a room's as the first square of its row and of its
// lights on Lights' page (room-sections.tsx), a floor's in the floor's
// heading, so its words are its accessible name and its tooltip, with whose
// lights they are and how many, "Turn off 2 lights in Kitchen". The core
// leaves offline lights alone, so while all of them are offline the switch
// is disabled, as their tiles are.

const onCount = (tiles: readonly Tile[]) =>
  tiles.filter((tile) => tile.on).length;

/** What the button says: what it does. */
export const lightsWords = (on: number) => (on === 0 ? "Turn on" : "Turn off");

const lightsCounted = (on: number) => (on === 1 ? "1 light" : `${on} lights`);

/** A place's button for all its lights, as lightsButton makes it. */
export type LightsSwitch = {
  on: number;
  /** Its words with whose lights they are, where several places' buttons are in reach. */
  label: string;
  disabled?: boolean;
  onToggle: () => void;
};

/** A floor's switch, in its heading: a chip's size, the power symbol alone. */
export function LightsButton(props: { lights: LightsSwitch }) {
  const { lights } = props;
  return (
    <Button
      variant="glass"
      size="icon-chip"
      aria-label={lights.label}
      title={lights.label}
      data-on={lights.on > 0 ? "" : undefined}
      disabled={lights.disabled}
      onClick={lights.onToggle}
    >
      <icons.Power aria-hidden="true" />
    </Button>
  );
}

// A room's switch: off while any light is on, on otherwise. The home has no
// such button: turning every light in it on at once is more than one press
// should do, so its lights can only be turned off, from Lights' card.
export function lightsButton(
  lights: Tile[],
  room: { id: string; name: string },
  devices: Devices,
): LightsSwitch | undefined {
  if (lights.length === 0) return undefined;
  const on = onCount(lights);
  return {
    on,
    label:
      on === 0
        ? `Turn on lights in ${room.name}`
        : `Turn off ${lightsCounted(on)} in ${room.name}`,
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

// A floor's switch only turns its lights off, as the home's does, and is
// there only while any of them is on: its rooms come on one by one, each by
// its own button.
export function floorLightsButton(
  lights: Tile[],
  floor: Floor,
  devices: Devices,
): LightsSwitch | undefined {
  const on = onCount(lights);
  if (on === 0) return undefined;
  return {
    on,
    label: `Turn off ${lightsCounted(on)} on ${floor.name}`,
    disabled: lights.every((tile) => tile.disabled),
    onToggle: () =>
      void devices
        .switchLights({ kind: "floor", id: floor.id }, lights, "off")
        .catch(() => undefined),
  };
}
