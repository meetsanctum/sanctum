import type {
  ActivityInfo,
  ActivityTrigger,
  ActivityWho,
} from "@meetsanctum/app-sdk";
import { timeText, type HomeClock } from "@meetsanctum/app-sdk/clock";
import { pressLabel } from "@meetsanctum/ui-sdk";

import { productName } from "../brand";
import { durationText } from "../device-history-data";

// A motion trigger's place, by its name, and how long it waited, where the
// run's trigger says them.
export function triggerWords(
  clock: HomeClock,
  trigger: ActivityTrigger,
  at: string,
) {
  switch (trigger.piece) {
    case "time": {
      const { time } = trigger;
      if (time === undefined || time === null) {
        return `at ${clock.timeText(Date.parse(at))}`;
      }
      // The schedule already holds wall time, so format it without shifting zones.
      const scheduled = Date.parse(`1970-01-01T${time}:00Z`);
      const shown = Number.isNaN(scheduled)
        ? time
        : timeText(scheduled, "UTC", clock.hourCycle);
      return `at ${shown}`;
    }
    case "sun": {
      const event = trigger.event ?? "sunset";
      const offset = trigger.offsetMinutes ?? 0;
      if (offset === 0) return `at ${event}`;
      return `${durationText(Math.abs(offset) * 60)} ${offset < 0 ? "before" : "after"} ${event}`;
    }
    case "manual":
      return "run by hand";
    case "press":
      return "at a press";
    case "motion":
      return trigger.place ? `motion in ${trigger.place}` : "after motion";
    case "noMotion": {
      const place = trigger.place ? ` in ${trigger.place}` : "";
      return trigger.forMinutes
        ? `no motion${place} for ${durationText(trigger.forMinutes * 60)}`
        : `after no motion${place}`;
    }
    case "device":
      // A contact sensor's change, by the sensor's name then and which way
      // it went; any other device's is a change.
      return trigger.opened === undefined
        ? "after a change"
        : `after ${trigger.device ?? "a contact sensor"} ${trigger.opened ? "opened" : "closed"}`;
    default:
      return "after a change";
  }
}

/** Who did it, on their own: a person, a device, an app, Sanctum. */
export function whoWords(who: ActivityWho): string {
  switch (who.kind) {
    case "person":
      return who.name ?? "Someone who has left";
    case "client":
      return who.name ?? "A shared device";
    case "workflow":
      return who.name ?? "An automation";
    case "app":
      return who.name ?? "An app";
    case "press":
      return `${who.name ?? "A remote"}, ${pressLabel(who.action).toLowerCase()}`;
    case "device":
      return `Outside ${productName}, at the device or its switch`;
    case "sanctum":
      return productName;
    case "agent":
      return who.name ?? "An AI agent";
    case "nobody":
      return "";
  }
}

/** Who did it, with the automation behind it and the app whose code it was. */
export function byWords(clock: HomeClock, entry: ActivityInfo) {
  const { who, run, app } = entry;
  const parts: string[] = [];
  if (who.kind === "workflow" && run) {
    parts.push(
      `${run.name ?? whoWords(who)}, ${triggerWords(clock, run.trigger, entry.at)}`,
    );
  } else {
    parts.push(whoWords(who));
    if (who.kind === "agent") {
      const attributedTo = who.askedBy ?? who.addedBy;
      if (attributedTo) {
        const { kind, name } = attributedTo;
        const fallback =
          kind === "person" ? "someone who has left" : "a shared device";
        // An assistant acts for a person, or for a shared device it was
        // asked on.
        const how = !who.askedBy
          ? "added by"
          : kind === "client"
            ? "asked from"
            : "asked by";
        parts.push(`${how} ${name ?? fallback}`);
      }
    }
    // The automation in between, unless an app keeps it for a press.
    if (
      run &&
      !run.app &&
      who.kind !== "workflow" &&
      entry.action !== "workflow.run"
    ) {
      parts.push(`through ${run.name ?? "an automation"}`);
    }
  }
  const shownApp =
    app && !(who.kind === "app" && who.id === app.id) ? app.name : null;
  if (shownApp) parts.push(`with ${shownApp}`);
  return parts.filter(Boolean).join(", ");
}
