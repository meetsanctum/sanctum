import type { Floor, LightsResult, LightsSwitch } from "@meetsanctum/app-sdk";
import { icons, SectionButton, type Tile } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

import { tileKey } from "./device-tiles";
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
// when a light comes on, the press fails or switches none, or time runs out.

/** How long a press may hold the button on while waiting for its lights. */
const turningOnMs = 5_000;

const hasLightsOn = (lights: readonly Tile[]) =>
  lights.some((tile) => tile.on && !tile.disabled);

/** A place's button for all its lights. */
export type LightsButtonState = {
  /** Whether any of its lights is on, as their tiles show. */
  isOn: boolean;
  /** The room's lit lights and their last turn-on commands, as the core shows. */
  coreLightsOn?: () => ReadonlyMap<string, string | null>;
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
  const [turningOn, setTurningOn] = useState<{
    press: object;
    alreadyOn: ReadonlyMap<string, string | null>;
  }>();
  const activePress = turningOn?.press;
  useEffect(() => {
    if (!activePress) return;
    const timer = setTimeout(() => {
      setTurningOn((current) =>
        current?.press === activePress ? undefined : current,
      );
    }, turningOnMs);
    return () => clearTimeout(timer);
  }, [activePress]);
  if (turningOn) {
    const onNow = lights.coreLightsOn?.();
    // A light that still shows on from before an earlier off press does
    // not confirm this press. It can confirm once it goes off and back on,
    // or the core shows a new turn-on command for it.
    if (onNow) {
      const { alreadyOn } = turningOn;
      if ([...onNow].some(([key, at]) => alreadyOn.get(key) !== at)) {
        setTurningOn(undefined);
      } else if (onNow.size < alreadyOn.size) {
        setTurningOn({ ...turningOn, alreadyOn: onNow });
      }
    }
  }
  const isOn = lights.isOn || turningOn !== undefined;
  const words = isOn || lights.offOnly ? "Turn off lights" : "Turn on lights";

  const press = () => {
    const to = isOn || lights.offOnly ? "off" : "on";
    const alreadyOn = to === "on" ? lights.coreLightsOn?.() : undefined;
    const pressed = {};
    setTurningOn(alreadyOn ? { press: pressed, alreadyOn } : undefined);
    const stop = () =>
      setTurningOn((current) =>
        current?.press === pressed ? undefined : current,
      );
    // Individual failures also show on the affected devices' tiles.
    void lights.switchLights(to).then(
      ({ switched, failed }) => {
        if (switched === 0) {
          stop();
          if (failed.length > 0) showFailure();
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
    coreLightsOn: () => {
      const on = new Map<string, string | null>();
      for (const device of devices.devices) {
        if (device.roomId !== room.id || device.availability === "offline") {
          continue;
        }
        for (const capability of device.capabilities) {
          if (capability.kind === "light" && capability.state?.on) {
            const { setBy } = capability;
            on.set(
              tileKey(device.id, capability.id),
              setBy?.asked.on === true ? setBy.at : null,
            );
          }
        }
      }
      return on;
    },
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
