import type { Floor, LightsResult, LightsSwitch } from "@meetsanctum/app-sdk";
import { icons, SectionButton, type Tile } from "@meetsanctum/ui-sdk";
import { useEffect, useRef, useState } from "react";

import type { Devices } from "./use-devices";

// The button for all the lights of a room or a floor: a chip of frosted
// glass, 36 px high, with the power symbol and its words, "Turn off
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
//
// Turning off shows at once, as the lights' tiles do. Turning on shows at
// once on the button alone: a room's turn-on rule may leave some lights
// off, so its tiles wait for what the core says, but once any light is on
// the button is White, so it is White from the press. It stays so until a
// light is on, and goes back if the core switched none or the press failed.

/** How long a press the core answered may hold the button on, at most. */
const turningOnMs = 5_000;

const hasLightsOn = (lights: readonly Tile[]) =>
  lights.some((tile) => tile.on && !tile.disabled);

/** A place's button for all its lights. */
export type LightsButtonState = {
  /** Whether any of its lights is on, as their tiles show. */
  isOn: boolean;
  /** Whose lights they are, in its accessible name: "in Kitchen". */
  where: string;
  /** A floor's only turns its lights off. */
  offOnly?: boolean;
  isDisabled: boolean;
  switchLights: (to: Exclude<LightsSwitch, "toggle">) => Promise<LightsResult>;
};

/**
 * A room's or a floor's button for all its lights: a chip, as the room's
 * other buttons beside it are (RoomRow), White while any light is on.
 */
export function LightsButton(props: { lights: LightsButtonState }) {
  const { lights } = props;
  const [failures, setFailures] = useState(0);
  const showFailure = () => setFailures((count) => count + 1);
  // The press turning the lights on, until one shows on.
  const [turningOn, setTurningOn] = useState<object>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (turningOn && lights.isOn) setTurningOn(undefined);
  const isOn = lights.isOn || turningOn !== undefined;
  const words = isOn || lights.offOnly ? "Turn off lights" : "Turn on lights";

  const press = () => {
    clearTimeout(timer.current);
    const to = isOn || lights.offOnly ? "off" : "on";
    const pressed = to === "on" ? {} : undefined;
    setTurningOn(pressed);
    const stop = () =>
      setTurningOn((current) => (current === pressed ? undefined : current));
    // Individual failures also show on the affected devices' tiles.
    void lights.switchLights(to).then(
      ({ switched, failed }) => {
        if (switched === 0) {
          stop();
          if (failed.length > 0) showFailure();
        } else if (pressed) {
          // Its lights' states are on their way; should they never come,
          // the tiles say what is on.
          timer.current = setTimeout(stop, turningOnMs);
        }
      },
      () => {
        stop();
        showFailure();
      },
    );
  };
  return (
    <SectionButton
      icon={icons.Power}
      name={words}
      label={`${words} ${lights.where}`}
      lit={isOn}
      disabled={lights.isDisabled}
      failures={failures}
      onClick={press}
    />
  );
}

// A room's button: off while any light is on, on otherwise.
export function roomLightsButton(
  lights: Tile[],
  room: { id: string; name: string },
  devices: Devices,
): LightsButtonState | undefined {
  if (lights.length === 0) return undefined;
  return {
    isOn: hasLightsOn(lights),
    where: `in ${room.name}`,
    isDisabled: lights.every((tile) => tile.disabled),
    switchLights: (to) =>
      devices.switchLights({ kind: "room", id: room.id }, lights, to),
  };
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
    where: `on ${floor.name}`,
    offOnly: true,
    isDisabled: !isOn,
    switchLights: (to) =>
      devices.switchLights({ kind: "floor", id: floor.id }, lights, to),
  };
}
