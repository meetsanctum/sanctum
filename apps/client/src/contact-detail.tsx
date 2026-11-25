import {
  maintenanceOf,
  type CapabilityInfo,
  type DeviceInfo,
} from "@meetsanctum/app-sdk";
import type { HomeClock } from "@meetsanctum/app-sdk/clock";

import { contactNowText } from "./contact";
import {
  contactSentence,
  contactSpanText,
  contactWeekHeadline,
  doorWeekHeadline,
  openedTimes,
} from "./contact-history-data";
import { DayAndWeek } from "./day-and-week";

// A contact sensor's Contact page, the first of its detail: its day and its
// week (day-and-week.tsx), with open as the White spans and closed as the
// hairline, in a contact sensor's words. The week is how long it was open
// each day; for a sensor shown as a door, how often it was opened, since a
// door is opened to go through and how long says little.

type Contact = Extract<CapabilityInfo, { kind: "contact" }>;

/**
 * What it says now: as its tile does while nothing is known of it, and
 * otherwise whether it is open, with since when it has been closed.
 */
export function contactNow(
  clock: HomeClock,
  device: DeviceInfo,
  capability: Contact,
  now: number,
) {
  if (device.availability === "offline") {
    return device.leftAt === null ? "Offline" : "Not paired";
  }
  if (maintenanceOf(device, now) === "quiet") return "Not heard from";
  if (!capability.state) return "Waiting for a reading";
  return contactNowText(
    clock,
    capability.state.open,
    capability.changedAt,
    now,
  );
}

export function ContactPage(props: {
  device: DeviceInfo;
  capability: Contact;
}) {
  const { device, capability } = props;
  const isDoor = device.shownAs === "door";
  return (
    <DayAndWeek
      device={device}
      capability={capability}
      words={{
        field: "open",
        now: (clock, now) => contactNow(clock, device, capability, now),
        sentence: contactSentence,
        band: "Open and closed over the last 24 hours",
        span: contactSpanText,
        week: isDoor ? doorWeekHeadline : contactWeekHeadline,
        counted: isDoor,
        columns: {
          label: isDoor
            ? "How often it was opened each day"
            : "How long it was open each day",
          none: isDoor ? "Not opened" : "Not open",
          spoken: (duration) => `open for ${duration}`,
          ...(isDoor && {
            counts: {
              value: openedTimes,
              spoken: (count) => openedTimes(count).toLowerCase(),
            },
          }),
        },
      }}
    />
  );
}
