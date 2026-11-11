import type { DeviceInfo } from "@meetsanctum/app-sdk";
import {
  formatLightLevel,
  icons,
  NativeSelect,
  NativeSelectOption,
  PageSection,
  Switch,
  type LucideIcon,
} from "@meetsanctum/ui-sdk";
import type { ReactNode } from "react";

import {
  darkerThanChoices,
  defaultTurnOffAfter,
  turnOffAfterChoices,
  type DarkerThan,
  type TurnOffAfter,
} from "../motion/room-motion.js";
import type { MotionChange, RoomMotion } from "./motion";
import { minutesWords, motionWords } from "./motion-words";
import { Squircle } from "./schedule-sections";

// The Motion section of Moods' page for a room, after Turning the lights on:
// whether motion turns the room's lights on, only below a light level if one
// is chosen, and whether they turn off after a while with no motion, with
// the room's motion sensors named beside the heading. The choices under a
// switch show while it is on. A room with no motion sensor has both switches
// dimmed, unless one is still on so it can be turned off; a room whose
// sensors read no light level has that choice dimmed, with why. While Moods
// may not see motion or light levels, turning a switch on or choosing a
// level asks for them first, and changes nothing on Not now. It is the
// household's, the same on every device.

// What motion needs: seeing it, and keeping the automations it runs.
const motionPermissions = ["devices.read:occupancy", "workflows.manage"];
const lightPermissions = ["devices.read:sensor"];

const lineLook = "text-[13px] leading-[18px] text-muted-foreground";

function Words(props: {
  id: string;
  name: string;
  line?: string;
  dimmed?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span
        id={`${props.id}-name`}
        className={`text-[15px] leading-5 font-medium ${props.dimmed ? "opacity-50" : ""}`}
      >
        {props.name}
      </span>
      {props.line && (
        <span id={`${props.id}-line`} className={lineLook}>
          {props.line}
        </span>
      )}
    </span>
  );
}

function SwitchRow(props: {
  id: string;
  icon: LucideIcon;
  name: string;
  line: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 rounded-sm px-2.5 py-2">
      <span className={props.disabled ? "opacity-50" : undefined}>
        <Squircle>
          <props.icon aria-hidden="true" />
        </Squircle>
      </span>
      <Words
        id={props.id}
        name={props.name}
        line={props.line}
        dimmed={props.disabled}
      />
      <Switch
        checked={props.checked}
        disabled={props.disabled}
        aria-labelledby={`${props.id}-name`}
        aria-describedby={`${props.id}-line`}
        onCheckedChange={props.onChange}
      />
    </div>
  );
}

// A choice under a switch, its words aligned with the switch's.
function SubRow(props: {
  id: string;
  name: string;
  line?: string;
  dimmed?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 rounded-sm py-2 ps-[50px] pe-2.5">
      <Words
        id={props.id}
        name={props.name}
        line={props.line}
        dimmed={props.dimmed}
      />
      {props.children}
    </div>
  );
}

/** What motion does to a room's lights, and changing it. */
export function MotionSection(props: {
  room: { id: string; name: string };
  devices: readonly DeviceInfo[];
  motion: RoomMotion;
  /** What Moods may not see yet, which a choice that needs it asks for. */
  unseen: { motion: boolean; light: boolean };
  ask: (permissions: readonly string[]) => Promise<boolean>;
  onChange: (change: MotionChange) => void;
}) {
  const { room, motion, unseen } = props;
  const words = motionWords({ room, devices: props.devices, motion });
  const turningOff = motion.turnOffAfter !== null;
  // Without a sensor that reads it, the level is any, whatever was chosen.
  const darkerThan = words.readsLight ? motion.darkerThan : null;
  // A change that needs what Moods may not see asks for it first.
  const change = (needs: readonly string[], next: MotionChange) => {
    if (needs.length === 0) {
      props.onChange(next);
      return;
    }
    void props.ask(needs).then(
      (allowed) => allowed && props.onChange(next),
      () => undefined,
    );
  };
  const asksMotion = "Moods asks to see motion when you turn this on";
  const foot = unseen.motion
    ? {
        text: "Moods sees your motion sensors once one of these is on.",
        bad: false,
      }
    : words.foot;
  return (
    <div className="flex flex-col gap-2">
      <PageSection id="motion-heading" title="Motion" hint={words.hint}>
        <SwitchRow
          id="motion-on"
          icon={icons.Footprints}
          name="Turn the lights on with motion"
          line={unseen.motion ? asksMotion : words.turnOnLine}
          checked={motion.turnOn}
          disabled={!unseen.motion && words.sensorless && !motion.turnOn}
          onChange={(turnOn) =>
            change(turnOn ? motionPermissions : [], {
              turnOn,
            })
          }
        />
        {motion.turnOn && (
          <SubRow
            id="motion-darker"
            name="Only when it's darker than"
            line={
              unseen.light
                ? "Moods asks to see light levels when you choose one"
                : words.levelLine
            }
            dimmed={!unseen.light && !words.readsLight}
          >
            <NativeSelect
              aria-labelledby="motion-darker-name"
              aria-describedby="motion-darker-line"
              disabled={!unseen.light && !words.readsLight}
              value={darkerThan === null ? "any" : String(darkerThan)}
              onChange={(event) => {
                const level =
                  event.target.value === "any"
                    ? null
                    : (Number(event.target.value) as DarkerThan);
                change(level !== null && unseen.light ? lightPermissions : [], {
                  darkerThan: level,
                });
              }}
            >
              <NativeSelectOption value="any">
                Any light level
              </NativeSelectOption>
              {darkerThanChoices.map((lux) => (
                <NativeSelectOption key={lux} value={String(lux)}>
                  {formatLightLevel(lux)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </SubRow>
        )}
        <SwitchRow
          id="motion-off"
          icon={icons.LightbulbOff}
          name="Turn the lights off with no motion"
          line={unseen.motion ? asksMotion : words.turnOffLine}
          checked={turningOff}
          disabled={!unseen.motion && words.sensorless && !turningOff}
          onChange={(on) =>
            change(on ? motionPermissions : [], {
              turnOffAfter: on ? defaultTurnOffAfter : null,
            })
          }
        />
        {turningOff && (
          <SubRow id="motion-after" name="After no motion for">
            <NativeSelect
              aria-labelledby="motion-after-name"
              value={String(motion.turnOffAfter)}
              onChange={(event) =>
                props.onChange({
                  turnOffAfter: Number(event.target.value) as TurnOffAfter,
                })
              }
            >
              {turnOffAfterChoices.map((minutes) => (
                <NativeSelectOption key={minutes} value={String(minutes)}>
                  {minutesWords(minutes)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </SubRow>
        )}
      </PageSection>
      <p
        role={foot.bad ? "status" : undefined}
        className={`m-0 flex gap-1.5 text-[13px] leading-[18px] font-medium ${
          foot.bad ? "text-destructive" : "text-muted-foreground"
        }`}
      >
        {foot.bad && (
          <icons.CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
        )}
        <span>{foot.text}</span>
      </p>
    </div>
  );
}
