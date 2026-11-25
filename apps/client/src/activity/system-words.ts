import type { ActivityInfo } from "@meetsanctum/app-sdk";
import type { HomeClock } from "@meetsanctum/app-sdk/clock";

import { productName } from "../brand";
import { durationText } from "../device-history-data";
import { formatBytes, serviceName } from "../system-status";
import { byWords } from "./actor-words";
import type { Words } from "./words";

// How the activity log's entries of Sanctum itself read: its starts,
// restarts, shutdowns and updates, its services, and the apps' versions it
// changes.

const serviceOf = (detail: ActivityInfo["detail"]) =>
  detail?.service === undefined || detail.service === null
    ? "A service"
    : serviceName(String(detail.service));

function updateEnd(entry: ActivityInfo): Words {
  const version = String(entry.detail?.version ?? "");
  const from = entry.detail?.from ? String(entry.detail.from) : null;
  switch (entry.detail?.outcome) {
    case "updated":
      return {
        title: `Updated to ${version}`,
        detail: productName,
        problem: false,
      };
    case "unchanged":
      return {
        title: "Already up to date",
        detail: productName,
        problem: false,
      };
    case "rolled-back":
      return {
        title: `The update to ${version} didn't work`,
        detail: `${productName} went back to ${from ?? "the version before"}, as it was. Try again once a newer version is out.`,
        problem: true,
      };
    default:
      return {
        title: `The update to ${version} didn't work`,
        detail: "Nothing changed.",
        problem: true,
      };
  }
}

// What a service's problem says, in the household's words.
function problemWords(problem: unknown) {
  const text = String(problem ?? "");
  if (text.startsWith("No Zigbee coordinator")) {
    return "No Zigbee adapter is plugged in. Plug it in, and Zigbee starts by itself.";
  }
  if (text.includes("is not plugged in")) {
    return "The Zigbee adapter it uses isn't plugged in. Plug it in again, and Zigbee starts by itself.";
  }
  if (text.startsWith("Several possible")) {
    return "Several Zigbee adapters are plugged in. Unplug the ones it shouldn't use.";
  }
  if (text.startsWith("Choose the adapter type")) {
    return `${productName} doesn't recognise this Zigbee adapter's type by itself. The install guide says how to choose it, under “Zigbee does not start”.`;
  }
  return "It will try again by itself.";
}

// An app's change of version, which Sanctum makes, by the name the entry
// kept for once the app is gone.
function versionEntry(entry: ActivityInfo): Words {
  const kept = entry.detail?.name;
  const name =
    entry.app?.name ?? (typeof kept === "string" ? kept : null) ?? "An app";
  const from = String(entry.detail?.from ?? "");
  const to = String(entry.detail?.to ?? "");
  const ok = entry.outcome === "ok";
  if (entry.action === "version.update") {
    return ok
      ? {
          title: `Updated ${name} to ${to}`,
          detail: productName,
          problem: false,
        }
      : {
          title: `${name} ${to} didn't start`,
          detail: `It went back to ${from}`,
          problem: true,
        };
  }
  return ok
    ? {
        title: `${name} went back to ${to}`,
        detail: productName,
        problem: false,
      }
    : {
        title: `${name} couldn't go back to ${to}`,
        detail: `It stayed on ${from}`,
        problem: true,
      };
}

export function systemEntry(
  clock: HomeClock,
  entry: ActivityInfo,
): Words | null {
  const detail = entry.detail;
  switch (entry.action) {
    case "version.update":
    case "version.back":
      return versionEntry(entry);
    case "sanctum.start": {
      const stoppedAt = detail?.stoppedAt
        ? Date.parse(String(detail.stoppedAt))
        : null;
      const off =
        stoppedAt !== null
          ? `It was off from ${clock.timeText(stoppedAt)}, for ${durationText((Date.parse(entry.at) - stoppedAt) / 1000)}`
          : detail?.unexpected
            ? "It had stopped unexpectedly"
            : `Version ${String(detail?.version ?? "")}`;
      return { title: `${productName} started`, detail: off, problem: false };
    }
    case "update.start":
      return {
        title:
          entry.outcome === "ok" ? "Update started" : "Update couldn't start",
        detail: byWords(clock, entry),
        problem: entry.outcome !== "ok",
      };
    case "sanctum.restart":
      return {
        title:
          entry.outcome === "ok"
            ? `Restarted ${productName}`
            : `Couldn't restart ${productName}`,
        detail: byWords(clock, entry),
        problem: entry.outcome !== "ok",
      };
    case "sanctum.shutdown":
      return {
        title:
          entry.outcome === "ok"
            ? `Shut ${productName} down`
            : `Couldn't shut ${productName} down`,
        detail: byWords(clock, entry),
        problem: entry.outcome !== "ok",
      };
    case "sanctum.space.free": {
      const freed = detail?.freed;
      return {
        title:
          entry.outcome !== "ok"
            ? "Couldn't free up space"
            : typeof freed === "number"
              ? `Freed ${formatBytes(freed)}`
              : "Freed up space",
        detail: byWords(clock, entry),
        problem: entry.outcome !== "ok",
      };
    }
    case "update.end":
      return updateEnd(entry);
    case "restore":
      return {
        title: "Restored a backup",
        detail:
          "Everyone was signed out, and signs in again as the backup had it",
        problem: false,
      };
    case "restore.dismiss":
      return {
        title: "Put the restore notice away",
        detail: byWords(clock, entry),
        problem: false,
      };
    case "service.start":
      return {
        title: `${serviceOf(detail)} started`,
        detail: productName,
        problem: false,
      };
    case "service.restart":
      return {
        title: `${serviceOf(detail)} started again`,
        detail: `It had stopped · ${productName}`,
        problem: false,
      };
    case "service.stop":
      return {
        title: `${serviceOf(detail)} stopped`,
        detail: "No app needs it now",
        problem: false,
      };
    case "service.fail":
      return {
        title: `${serviceOf(detail)} stopped unexpectedly`,
        detail: "It will start again by itself",
        problem: true,
      };
    case "service.wait":
      return {
        title: `${serviceOf(detail)} couldn't start`,
        detail: problemWords(detail?.problem),
        problem: true,
      };
    case "zigbee.adapter":
      return {
        title: "Zigbee uses the adapter plugged in",
        detail: detail?.by === "person" ? "Chosen by hand" : productName,
        problem: false,
      };
  }
  return null;
}
