import type { Floor, LightsResult, LightsSwitch } from "@meetsanctum/app-sdk";
import { icons, SectionButton, type Tile } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

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
// the button is White, so it is White from the press. The tiles take over
// once the core has answered the press and a light shows on, when the
// press fails or switches none, or when time runs out.

/** How long a press may hold the button on while waiting for its lights. */
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

/** What a press on a place's lights shows, and the press itself. */
export type LightsPress = {
  /** Whether its lights show as on, a turn-on press's among them. */
  isOn: boolean;
  /** What a press does now: "Turn off lights" or "Turn on lights". */
  words: string;
  /** Its words with whose lights they are, its accessible name. */
  label: string;
  /** How many presses have failed here, so each shows. */
  failures: number;
  press: () => void;
};

/**
 * Pressing a place's lights: off or on as its words say, a turn-on press
 * showing as on from the press until its lights do.
 */
export function useLightsPress(lights: LightsButtonState): LightsPress {
  const [failures, setFailures] = useState(0);
  const showFailure = () => setFailures((count) => count + 1);
  // The press turning the lights on, and whether the core has answered it:
  // a light that shows on before then may still be on from before an
  // earlier off press, whose request goes first.
  const [turningOn, setTurningOn] = useState<{
    press: object;
    answered: boolean;
  }>();
  const pressing = turningOn?.press;
  useEffect(() => {
    if (!pressing) return;
    const timer = setTimeout(
      () =>
        setTurningOn((current) =>
          current?.press === pressing ? undefined : current,
        ),
      turningOnMs,
    );
    return () => clearTimeout(timer);
  }, [pressing]);
  if (turningOn?.answered && lights.isOn) setTurningOn(undefined);
  const isOn = lights.isOn || turningOn !== undefined;
  const words = isOn || lights.offOnly ? "Turn off lights" : "Turn on lights";

  const press = () => {
    const to = isOn || lights.offOnly ? "off" : "on";
    const pressed = {};
    setTurningOn(to === "on" ? { press: pressed, answered: false } : undefined);
    const settle = (keep: boolean) =>
      setTurningOn((current) =>
        current?.press !== pressed
          ? current
          : keep
            ? { press: pressed, answered: true }
            : undefined,
      );
    // Individual failures also show on the affected devices' tiles.
    void lights.switchLights(to).then(
      ({ switched, failed }) => {
        settle(switched > 0);
        if (switched === 0 && failed.length > 0) showFailure();
      },
      () => {
        settle(false);
        showFailure();
      },
    );
  };
  return { isOn, words, label: `${words} ${lights.where}`, failures, press };
}

/**
 * A room's or a floor's button for all its lights: a chip, as the room's
 * other buttons beside it are (RoomRow), White while any light is on.
 */
export function LightsButton(props: { lights: LightsButtonState }) {
  const { isOn, words, label, failures, press } = useLightsPress(props.lights);
  return (
    <SectionButton
      icon={icons.Power}
      name={words}
      label={label}
      lit={isOn}
      disabled={props.lights.isDisabled}
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
