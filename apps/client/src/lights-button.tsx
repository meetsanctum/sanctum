import type { Floor, LightsResult } from "@meetsanctum/app-sdk";
import { icons, SectionButton, type Tile } from "@meetsanctum/ui-sdk";
import { useState } from "react";

import type { Devices } from "./use-devices";

// A floor's button for all its lights: a chip of frosted glass, 36 px high,
// under the floor's name, with the power symbol and "Turn off lights",
// White while any light is on, by its own state and not as a pressed
// switch, since its words already say what it does. Its accessible name
// adds whose lights they are, "Turn off lights on Ground floor", since
// several are in reach at once. It only turns the floor's lights off: its
// rooms come on one by one, each by its own Lights tile (room-lights.tsx),
// so while none is on it stays, disabled, and nothing moves. It sends the
// core off, and no toggle, so a screen a moment behind never does the
// opposite.

const hasLightsOn = (lights: readonly Tile[]) =>
  lights.some((tile) => tile.on && !tile.disabled);

/** A place's button for all its lights. */
export type LightsButtonState = {
  isOn: boolean;
  /** What it shows: "Turn off lights" or "Turn on lights". */
  words: string;
  /** Its words with whose lights they are, its accessible name. */
  label: string;
  isDisabled: boolean;
  onPress: () => Promise<LightsResult>;
};

/** A floor's button for all its lights: a chip, White while any is on. */
export function LightsButton(props: { lights: LightsButtonState }) {
  const { lights } = props;
  const [failures, setFailures] = useState(0);
  const showFailure = () => setFailures((count) => count + 1);
  const press = () => {
    // Individual failures also show on the affected devices' tiles.
    void lights.onPress().then(({ switched, failed }) => {
      if (switched === 0 && failed.length > 0) showFailure();
    }, showFailure);
  };
  return (
    <SectionButton
      icon={icons.Power}
      name={lights.words}
      label={lights.label}
      lit={lights.isOn}
      disabled={lights.isDisabled}
      failures={failures}
      onClick={press}
    />
  );
}

// A floor's button, which only turns its lights off.
export function floorLightsButton(
  lights: Tile[],
  floor: Floor,
  devices: Devices,
): LightsButtonState | undefined {
  if (lights.length === 0) return undefined;
  const isOn = hasLightsOn(lights);
  return {
    isOn,
    words: "Turn off lights",
    label: `Turn off lights on ${floor.name}`,
    isDisabled: !isOn,
    onPress: () =>
      devices.switchLights({ kind: "floor", id: floor.id }, lights, "off"),
  };
}
