import type { CapabilityInfo, DeviceInfo } from "@meetsanctum/app-sdk";

import { DayAndWeek } from "./day-and-week";
import { motionText } from "./motion";
import {
  motionSentence,
  motionSpanText,
  motionWeekHeadline,
} from "./motion-history-data";

// A motion sensor's Motion page, the first of its detail: its day and its
// week (day-and-week.tsx), with motion as the White spans and quiet as the
// hairline, in a motion sensor's words.

type Motion = Extract<CapabilityInfo, { kind: "motion" }>;

/** What it says now, as its tile does. */
function nowText(device: DeviceInfo, capability: Motion, now: number) {
  if (device.availability === "offline") return "Offline";
  if (!capability.state) return "Waiting for a reading";
  return motionText(capability.state.motion, capability.changedAt, now);
}

export function MotionPage(props: { device: DeviceInfo; capability: Motion }) {
  const { device, capability } = props;
  return (
    <DayAndWeek
      device={device}
      capability={capability}
      words={{
        field: "motion",
        now: (now) => nowText(device, capability, now),
        sentence: motionSentence,
        band: "Motion over the last 24 hours",
        span: motionSpanText,
        week: motionWeekHeadline,
        columns: {
          label: "How long there was motion each day",
          none: "No motion",
          spoken: (duration) => `${duration} of motion`,
        },
      }}
    />
  );
}
