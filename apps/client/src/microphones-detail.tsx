import type {
  AudioCommand,
  CapabilityInfo,
  DeviceInfo,
} from "@meetsanctum/app-sdk";
import { PageSection, Switch } from "@meetsanctum/ui-sdk";
import { MicOff } from "lucide-react";
import { useState } from "react";

import { coreJson } from "./core-fetch";
import { productName } from "./brand";

// A smart speaker's Microphones page: whether they're on, which mutes or
// unmutes them through core Devices as any command goes, and when it last
// heard its wake word. A speaker with a mute switch of its own, on its
// side, is muted by that too, and while that one is on, nothing else turns
// them back on: an unmute the speaker doesn't confirm says so.

export type Audio = Extract<CapabilityInfo, { kind: "audio" }>;

export const isAudio = (capability: CapabilityInfo): capability is Audio =>
  capability.kind === "audio";

/** When it last heard its wake word: Today at 21:14, Yesterday at 07:02, 17 Nov at 09:30. */
export function heardWords(
  at: string | undefined,
  now: Date,
  timeZone?: string,
) {
  if (at === undefined) return "Not yet";
  const calendar = new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone,
  });
  const day = (date: Date) => {
    const { year, month, day } = Object.fromEntries(
      calendar
        .formatToParts(date)
        .map(({ type, value }) => [type, Number(value)]),
    );
    return Date.UTC(year!, month! - 1, day!);
  };
  const heard = new Date(at);
  const time = heard.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
  const daysAgo = (day(now) - day(heard)) / 86_400_000;
  const words =
    daysAgo === 0
      ? "Today"
      : daysAgo === 1
        ? "Yesterday"
        : heard.toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            timeZone,
          });
  return `${words} at ${time}`;
}

export function MicrophonesPage(props: {
  device: DeviceInfo;
  capability: Audio;
  /** The minute it is, which "Today" and "Yesterday" follow. */
  now: Date;
}) {
  const { device, capability } = props;
  const [failed, setFailed] = useState(false);
  const muted = capability.state?.muted;
  const canMute = capability.features.mutes && muted !== undefined;
  const reachable = device.availability !== "offline";
  const busy = capability.sync === "pending";
  // An unmute it didn't take: its own switch still holds them.
  const stillMuted =
    capability.features.muteSwitch &&
    capability.sync === "conflict" &&
    muted === true;

  async function change(on: boolean) {
    setFailed(false);
    const command: AudioCommand = { muted: !on };
    try {
      await coreJson("/api/devices/command", {
        method: "POST",
        json: { device: device.id, capability: capability.id, command },
      });
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <PageSection id={`${device.id}-microphones`} title="Microphones">
        {canMute && (
          <div className="flex min-h-13 items-center justify-between gap-3 px-2.5 text-[15px] leading-5">
            <label
              htmlFor={`${device.id}-microphones-switch`}
              className="flex min-w-0 flex-col"
            >
              <span>Microphones</span>
              <span className="flex items-center gap-1.5 text-[13px] leading-[18px] text-muted-foreground">
                {muted ? (
                  <>
                    <MicOff aria-hidden="true" className="size-3.5" />
                    Muted
                  </>
                ) : (
                  "On"
                )}
              </span>
            </label>
            <Switch
              id={`${device.id}-microphones-switch`}
              checked={!muted}
              disabled={!reachable || busy}
              onCheckedChange={(on) => void change(on)}
            />
          </div>
        )}
        <div className="flex min-h-11 items-center justify-between gap-3 px-2.5 text-[15px] leading-5">
          <span className="text-muted-foreground">Heard its wake word</span>
          <span>{heardWords(capability.state?.heardAt, props.now)}</span>
        </div>
      </PageSection>
      {stillMuted ? (
        <p
          role="alert"
          className="m-0 px-1 text-[13px] leading-[18px] text-destructive"
        >
          They're still muted. Turn off the switch on its side to turn them on.
        </p>
      ) : failed ? (
        <p
          role="alert"
          className="m-0 px-1 text-[13px] leading-[18px] text-destructive"
        >
          Couldn't change them. Check it's switched on, then try again.
        </p>
      ) : (
        <p className="m-0 px-1 text-[13px] leading-[18px] text-muted-foreground">
          When it hears its wake word, it chimes and flashes red: {productName}{" "}
          doesn't answer it.
          {capability.features.muteSwitch &&
            " The switch on its side mutes the microphones too, and while it's on, only that switch turns them back on."}
        </p>
      )}
    </div>
  );
}
