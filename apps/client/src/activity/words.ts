import {
  deviceTypes,
  type ActivityInfo,
  type MotionCommand,
} from "@meetsanctum/app-sdk";
import type { HomeClock } from "@meetsanctum/app-sdk/clock";
import { pressLabel } from "@meetsanctum/ui-sdk";

import { productName } from "../brand";
import { clearAfterWords, sensitivityLabel } from "../motion-settings";
import { byWords, triggerWords, whoWords } from "./actor-words";
import { aiEntry } from "./ai-words";
import { systemEntry } from "./system-words";

// How an entry of the activity log reads: a title saying what happened, in
// sentence case, and a line saying who did it and with which app, or what a
// press or a run led to. In a device's own list the title leaves its name
// out; in the home's, it starts with it. Who is a person by name, a shared
// device by its name then, an app, an automation with what started it, a
// remote's press, Outside Sanctum for a change at the device, or Sanctum
// itself: never the machine.

export type Where = "device" | "home";

export type Words = {
  title: string;
  detail: string;
  /** It failed or was refused: shown with an icon and words in red. */
  problem: boolean;
};

type Asked = {
  on?: boolean;
  brightness?: number;
  colorTemperature?: number;
  hue?: number;
  saturation?: number;
};

// A white light's colour in words, by its mireds.
function whiteWords(mireds: number) {
  if (mireds >= 333) return "warm white";
  if (mireds <= 200) return "cool white";
  return "white";
}

function lookWords(asked: Asked) {
  const parts: string[] = [];
  if (asked.brightness !== undefined) parts.push(`${asked.brightness}%`);
  if (asked.colorTemperature !== undefined) {
    parts.push(whiteWords(asked.colorTemperature));
  } else if (asked.hue !== undefined || asked.saturation !== undefined) {
    parts.push("a colour");
  }
  return parts.join(", ");
}

/** What a command asked for, as "Turned on at 40%". */
export function commandWords(asked: Asked) {
  const look = lookWords(asked);
  if (asked.on === true) return look ? `Turned on at ${look}` : "Turned on";
  if (asked.on === false) return "Turned off";
  return look ? `Set to ${look}` : "Changed";
}

// What it did not do, as "turn off".
function verbOf(asked: Asked) {
  if (asked.on === true) return "turn on";
  if (asked.on === false) return "turn off";
  return "change";
}

// A motion sensor's settings a command asked for, if that is what it
// asked.
function motionSettings(asked: Record<string, unknown>) {
  const settings = asked as MotionCommand;
  return settings.sensitivity !== undefined ||
    settings.clearAfter !== undefined ||
    settings.indicator !== undefined
    ? settings
    : null;
}

// A motion sensor's setting changed, as "Office motion sensor's
// sensitivity set to High" in the home's list or "Sensitivity set to High"
// in its own, and what it didn't do when it didn't.
function settingWords(settings: MotionCommand, name: string | null) {
  // The sentence about it, with its name in the home's list.
  const said = (owned: string, plain: string) =>
    name ? `${name}${owned}` : capitalize(plain.trimStart());
  if (Object.keys(settings).length > 1) {
    return {
      done: said("'s motion settings changed", "motion settings changed"),
      verb: "change its motion settings",
    };
  }
  if (settings.sensitivity !== undefined) {
    const level = sensitivityLabel(settings.sensitivity);
    return {
      done: said(
        `'s sensitivity set to ${level}`,
        `sensitivity set to ${level}`,
      ),
      verb: `set its sensitivity to ${level}`,
    };
  }
  if (settings.clearAfter !== undefined) {
    const after = `says no motion after ${clearAfterWords(settings.clearAfter)}`;
    return {
      done: said(` ${after}`, after),
      verb: "change when it says no motion",
    };
  }
  const blinks = settings.indicator
    ? "blinks on motion"
    : "no longer blinks on motion";
  return {
    done: said(` ${blinks}`, blinks),
    verb: `${settings.indicator ? "start" : "stop"} blinking on motion`,
  };
}

const capitalize = (text: string) =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

// What a press or a run led to.
function causedWords(entry: ActivityInfo) {
  const caused = entry.caused;
  if (entry.detail?.captured) {
    return "Heard while choosing a press, so it did nothing";
  }
  if (!caused) return "";
  const parts: string[] = [];
  const runs = caused.runs.map((run) => run.name ?? "an automation");
  if (runs.length > 0) {
    parts.push(
      runs.length === 1
        ? `Ran ${runs[0]}`
        : `Ran ${runs[0]} and ${runs.length - 1} more`,
    );
  }
  const devices = caused.devices.map((device) => device.name ?? "a device");
  const changed =
    devices.length === 0
      ? null
      : devices.length === 1
        ? devices[0]!
        : `${devices.length} devices`;
  const apps = caused.apps.map((app) => app.name ?? "An app");
  if (apps.length > 0 && runs.length === 0) {
    parts.push(
      changed
        ? `${apps.join(" and ")} changed ${changed}`
        : `${apps.join(" and ")} did it`,
    );
  } else if (changed) {
    parts.push(`changed ${changed}`);
  }
  if (parts.length === 0) {
    return entry.action === "device.press"
      ? "Nothing is set for it"
      : "It did nothing";
  }
  const text = parts.join(", ");
  const failed =
    caused.failed > 0
      ? `, ${caused.failed === 1 ? "1 didn't answer" : `${caused.failed} didn't answer`}`
      : "";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${failed}`;
}

const subjectName = (entry: ActivityInfo, fallback: string) =>
  entry.subject?.name ?? fallback;

// A title about a thing, with its name in the home's list.
function about(entry: ActivityInfo, where: Where, words: string) {
  if (where === "device") return words;
  const name = subjectName(entry, "A device");
  return `${name} ${words.charAt(0).toLowerCase()}${words.slice(1)}`;
}

function spanWords(clock: HomeClock, entry: ActivityInfo) {
  if (!entry.firstAt) return "";
  const from = clock.timeText(Date.parse(entry.firstAt));
  const to = clock.timeText(Date.parse(entry.at));
  return from === to ? "" : `${from}–${to}`;
}

// A remote's hold moving a light's brightness.
const moveWords: Record<string, { done: string; verb: string }> = {
  up: { done: "Brightened while held", verb: "brighten" },
  down: { done: "Dimmed while held", verb: "dim" },
  stop: { done: "Stopped", verb: "stop" },
};

// A smart speaker's microphones muted or turned on.
function microphoneWords(muted: boolean) {
  return muted
    ? { done: "Muted its microphones", verb: "mute its microphones" }
    : { done: "Turned on its microphones", verb: "turn on its microphones" };
}

function commandEntry(
  clock: HomeClock,
  entry: ActivityInfo,
  where: Where,
): Words {
  const asked = (entry.detail?.asked ?? {}) as Asked;
  const muted = (asked as { muted?: unknown }).muted;
  const move =
    typeof entry.detail?.move === "string"
      ? moveWords[entry.detail.move]
      : entry.detail?.capabilityKind === "audio" && typeof muted === "boolean"
        ? microphoneWords(muted)
        : undefined;
  // One its device did not confirm in time went again: it says so, however
  // it ended.
  const by = [
    byWords(clock, entry),
    entry.detail?.resent === true ? "Sent again" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const settings = motionSettings(asked);
  if (settings) {
    const words = settingWords(
      settings,
      where === "home" ? subjectName(entry, "A motion sensor") : null,
    );
    if (entry.outcome === "ok") {
      return { title: words.done, detail: by, problem: false };
    }
    return {
      title: about(entry, where, failedWords(entry, words.verb)),
      detail: by,
      problem: true,
    };
  }
  if (entry.outcome !== "ok") {
    const title = failedWords(entry, move?.verb ?? verbOf(asked));
    return { title: about(entry, where, title), detail: by, problem: true };
  }
  if (entry.count > 1) {
    const from = (entry.detail?.from ?? {}) as Asked;
    const range =
      from.brightness !== undefined && asked.brightness !== undefined
        ? `, ${from.brightness}% to ${asked.brightness}%`
        : "";
    return {
      title: about(entry, where, `Adjusted ${entry.count} times${range}`),
      detail: [by, spanWords(clock, entry)].filter(Boolean).join(" · "),
      problem: false,
    };
  }
  return {
    title: about(entry, where, move?.done ?? commandWords(asked)),
    detail: by,
    problem: false,
  };
}

// A command that didn't work, as "Didn't turn off: it didn't answer".
function failedWords(entry: ActivityInfo, verb: string) {
  return entry.reason === "no_answer"
    ? `Didn't ${verb}: it didn't answer`
    : entry.outcome === "refused"
      ? `Couldn't ${verb}`
      : `Didn't ${verb}`;
}

function deviceEntry(
  clock: HomeClock,
  entry: ActivityInfo,
  where: Where,
  rooms: RoomNames,
): Words | null {
  const by = byWords(clock, entry);
  const said = (title: string, detail = by) => ({
    title: about(entry, where, title),
    detail,
    problem: entry.outcome !== "ok",
  });
  switch (entry.action) {
    case "device.command":
      return commandEntry(clock, entry, where);
    case "device.changed":
      return said(entry.detail?.on ? "Turned on" : "Turned off");
    case "device.press": {
      const press = pressLabel(String(entry.detail?.action ?? ""));
      const times = entry.count > 1 ? `, ${entry.count} times` : "";
      return {
        title:
          where === "device"
            ? `${press}${times}`
            : `${press} on ${subjectName(entry, "a remote")}${times}`,
        detail: causedWords(entry),
        problem: (entry.caused?.failed ?? 0) > 0,
      };
    }
    case "device.announce":
      return said(
        `${entry.outcome === "ok" ? "Said" : "Couldn't say"} “${String(entry.detail?.text ?? "")}”`,
      );
    case "device.offline":
      return said("Went offline", "It stopped answering");
    case "device.online":
      return said("Back online", "It answers again");
    case "device.left": {
      // The driver that said so names the network.
      const network = entry.app?.name ? `the ${entry.app.name}` : "its";
      return said(
        `Left ${network} network`,
        "Its network no longer has it, as after a reset",
      );
    }
    case "device.quiet":
      return said(
        "Went quiet",
        typeof entry.detail?.battery === "number"
          ? `Not heard from, last at ${entry.detail.battery}%`
          : "Not heard from",
      );
    case "device.battery.low":
      return said(
        "Has a low battery",
        // Its charge where that is what is low, not where the device said so.
        typeof entry.detail?.battery === "number"
          ? `${entry.detail.battery}%: replace it soon`
          : "Replace it soon",
      );
    case "device.battery.new":
      return said(
        "Has a new battery",
        `${String(entry.detail?.battery)}%, up from ${String(entry.detail?.was)}%`,
      );
    case "device.register":
      return said("Joined", "");
    case "device.update": {
      if (entry.detail && "roomId" in entry.detail) {
        const room = entry.detail.roomId
          ? rooms(String(entry.detail.roomId))
          : null;
        return said(
          entry.detail.roomId
            ? `Moved to ${room ?? "another room"}`
            : "Taken out of its room",
        );
      }
      // What the household shows it as, by what it then is.
      if (entry.detail && "shownAs" in entry.detail) {
        const noun = deviceTypes.find(
          (type) => type.id === entry.detail?.type,
        )?.noun;
        return said(noun ? `Shown as a ${noun}` : "Shown as another type");
      }
      // Its name then is the new one, so the title starts with neither.
      return {
        title: entry.detail?.name
          ? `Renamed ${String(entry.detail.name)}`
          : "Renamed",
        detail: by,
        problem: false,
      };
    }
    case "device.remove":
      return said(entry.outcome === "ok" ? "Removed" : "Couldn't be removed");
    // In the words its driver declares for what's wrong.
    case "device.problem":
      return {
        ...said(
          "Has a problem",
          typeof entry.detail?.problem === "string" ? entry.detail.problem : "",
        ),
        problem: true,
      };
    case "device.repair":
      return said(entry.outcome === "ok" ? "Repaired" : "Couldn't be repaired");
    // One someone added from what its driver found.
    case "device.add":
      return said(entry.outcome === "ok" ? "Added" : "Couldn't be added");
    // Home by its name then.
    case "device.home.add":
      return said(`Added to ${String(entry.detail?.dashboard ?? "Home")}`);
    case "device.home.remove":
      return said(`Removed from ${String(entry.detail?.dashboard ?? "Home")}`);
    case "device.firmware.check":
      return said("Checked for new firmware");
    case "device.firmware.update":
      return said(
        entry.outcome === "ok"
          ? "Firmware update started"
          : "Firmware update couldn't start",
      );
    case "device.firmware.stop":
      return said("Firmware update stopped");
    case "device.probe":
      return said(
        entry.reason === "no_answer"
          ? "Checked its connection: it didn't answer"
          : "Checked its connection",
      );
    case "device.identify":
      // Only a blink that didn't happen is kept.
      return said("Couldn't blink");
    case "history.keep":
      return said("History kept again");
    case "history.forget":
      return said("History no longer kept");
  }
  return null;
}

function runEntry(clock: HomeClock, entry: ActivityInfo): Words {
  const name = entry.run?.name ?? entry.subject?.name ?? "an automation";
  const status = String(entry.detail?.status ?? "");
  const started =
    entry.who.kind === "workflow" && entry.run
      ? triggerWords(clock, entry.run.trigger, entry.at)
      : whoWords(entry.who);
  const detail = `${started.charAt(0).toUpperCase()}${started.slice(1)}`;
  if (entry.reason === "interrupted") {
    return {
      title: `${name} didn't finish`,
      detail: `${productName} stopped while it ran`,
      problem: true,
    };
  }
  if (status === "failed")
    return { title: `${name} didn't work`, detail, problem: true };
  if (status === "partial") {
    return { title: `Some of ${name} didn't work`, detail, problem: true };
  }
  if (status === "cancelled")
    return { title: `${name} was stopped`, detail, problem: false };
  return { title: `Ran ${name}`, detail, problem: false };
}

// The things people set up, by what they are.
const things: Record<string, string> = {
  room: "the room",
  floor: "the floor",
  zone: "the zone",
  workflow: "the automation",
  dashboard: "the dashboard",
};
const doneWords: Record<string, string> = {
  add: "Added",
  update: "Changed",
  remove: "Removed",
};

function setupEntry(clock: HomeClock, entry: ActivityInfo): Words | null {
  const by = byWords(clock, entry);
  const name = entry.subject?.name;
  const [noun, verb] = entry.action.split(".");
  const said = (title: string) => ({
    title,
    detail: by,
    problem: entry.outcome !== "ok",
  });
  if (noun && verb && things[noun] && doneWords[verb]) {
    return said(`${doneWords[verb]} ${things[noun]}${name ? ` ${name}` : ""}`);
  }
  if (noun === "person" && verb && doneWords[verb]) {
    return said(`${doneWords[verb]} ${name ?? "someone"}`);
  }
  switch (entry.action) {
    case "dashboard.order":
      return said(`Rearranged ${name ?? "Home"}`);
    case "settings.update":
      return said(
        entry.outcome === "ok"
          ? "Changed app settings"
          : "Couldn't change app settings",
      );
    case "app.delete": {
      const kept = entry.detail?.name;
      const app =
        entry.app?.name ?? (typeof kept === "string" ? kept : null) ?? "an app";
      const ok = entry.outcome === "ok";
      return {
        title: ok ? `Deleted ${app}'s data` : `Couldn't delete ${app}'s data`,
        // Sanctum, once its 30 days were over, or whoever asked.
        detail: whoWords(entry.who),
        problem: !ok,
      };
    }
    case "app.add":
    case "app.remove": {
      // By the name the entry kept, for an app that's gone since; the app
      // is what was added or removed, so only who did it follows.
      const kept = entry.detail?.name;
      const app =
        entry.app?.name ?? (typeof kept === "string" ? kept : null) ?? "an app";
      const ok = entry.outcome === "ok";
      const [done, couldNot] =
        entry.action === "app.add" ? ["Added", "add"] : ["Removed", "remove"];
      return {
        title: ok ? `${done} ${app}` : `Couldn't ${couldNot} ${app}`,
        detail: whoWords(entry.who),
        problem: !ok,
      };
    }
    case "turn-off":
      return said(
        entry.outcome === "ok"
          ? "Turned the app off"
          : "Couldn't turn the app off",
      );
    case "turn-on":
      return said(
        entry.outcome === "ok"
          ? "Turned the app on"
          : "Couldn't turn the app on",
      );
    case "restart":
      return said(
        entry.outcome === "ok"
          ? "Restarted the app"
          : "Couldn't restart the app",
      );
    case "go-back":
      return said(
        entry.outcome === "ok"
          ? "Went back to the app's version before"
          : "Couldn't go back to the app's version before",
      );
    case "allow-update":
      return said(
        entry.outcome === "ok"
          ? "Allowed the app's new version"
          : "Couldn't allow the app's new version",
      );
    case "home.update":
      return said("Changed the home's details");
    case "home.suggestLocation":
      return said("Looked up where the home is");
    case "login.set":
      return said(`Set ${name ? `${name}'s` : "a"} sign-in`);
    case "login.remove":
      return said(`Removed ${name ? `${name}'s` : "a"} sign-in`);
    case "password.change":
      return said(`Changed ${name ? `${name}'s` : "a"} password`);
    case "sign-in":
      return entry.outcome === "ok"
        ? said("Signed in")
        : { title: "A sign-in didn't work", detail: by, problem: true };
    case "host.claim":
      return said(`Set up ${productName}`);
    case "pair.request":
      return said("A shared device asked to join");
    case "pair.approve":
      return said("Let a shared device join");
    case "pair.check":
      // The home couldn't check a shared device that asked to join, so it
      // can't join with that code.
      return {
        title:
          entry.reason === "channel_mismatch"
            ? `A shared device wasn't connected to ${productName} directly`
            : "Couldn't check a shared device",
        detail: by,
        problem: true,
      };
    case "client.pair":
      return said(`Paired ${name ?? "a device"}`);
    case "client.rename": {
      const renamedTo = entry.detail?.name;
      if (entry.detail?.kind === "agent" && typeof renamedTo === "string") {
        return said(`Renamed an AI agent to ${renamedTo}`);
      }
      return said(`Renamed a device ${name ?? ""}`.trim());
    }
    case "client.revoke":
      return entry.detail?.kind === "agent"
        ? said(`Removed ${name ?? "an AI agent"}`)
        : said(`Signed out ${name ?? "a device"}`);
    case "pairing.open":
      return said("Let devices join");
    case "pairing.close":
      return said("Stopped letting devices join");
  }
  return null;
}

/** A room's name by its id, from the places the client has. */
export type RoomNames = (id: string) => string | null;

/** How an entry reads, in a device's list or the home's. */
export function activityWords(
  clock: HomeClock,
  entry: ActivityInfo,
  where: Where = "home",
  rooms: RoomNames = () => null,
): Words {
  // An app's action about one of its devices: what it did, said of the
  // device, and how many times as a slider's steps join.
  if (entry.done && entry.subject?.type === "device") {
    if (entry.outcome !== "ok") {
      const title = `${entry.title ?? entry.action} didn't work`;
      return {
        title:
          where === "device"
            ? title
            : `${subjectName(entry, "A device")}: ${title}`,
        detail: byWords(clock, entry),
        problem: true,
      };
    }
    const times = entry.count > 1 ? `, ${entry.count} times` : "";
    return {
      title: about(entry, where, `${entry.done}${times}`),
      detail: [
        byWords(clock, entry),
        entry.count > 1 ? spanWords(clock, entry) : "",
      ]
        .filter(Boolean)
        .join(" · "),
      problem: false,
    };
  }
  if (entry.action === "workflow.run") return runEntry(clock, entry);
  const words =
    systemEntry(clock, entry) ??
    deviceEntry(clock, entry, where, rooms) ??
    aiEntry(clock, entry) ??
    setupEntry(clock, entry);
  if (words) return words;
  // An app's action, by its title.
  const title = entry.title ?? entry.action;
  return {
    title: entry.outcome === "ok" ? title : `${title} didn't work`,
    detail: byWords(clock, entry),
    problem: entry.outcome !== "ok",
  };
}

/** The last change a device's list starts with, as "Alex turned it on at 21:52". */
export function lastChangeWords(clock: HomeClock, entry: ActivityInfo) {
  const at = clock.timeText(Date.parse(entry.at));
  if (entry.source === "devices" && entry.action === "device.press") {
    return `${pressLabel(String(entry.detail?.action ?? ""))} at ${at}`;
  }
  const who =
    entry.who.kind === "press"
      ? (entry.who.name ?? "A remote")
      : whoWords(entry.who) || "Someone";
  if (entry.done) {
    return `${who} ${entry.done.charAt(0).toLowerCase()}${entry.done.slice(1)} at ${at}`;
  }
  const asked = (
    entry.action === "device.changed"
      ? { on: entry.detail?.on }
      : (entry.detail?.asked ?? {})
  ) as Asked;
  if (entry.who.kind === "device") {
    return `${asked.on ? "Switched on" : "Switched off"} outside ${productName} at ${at}`;
  }
  const did =
    entry.count > 1
      ? "adjusted it"
      : asked.on === true
        ? "turned it on"
        : asked.on === false
          ? "turned it off"
          : asked.brightness !== undefined
            ? `set it to ${asked.brightness}%`
            : "changed it";
  return `${who} ${did} at ${at}`;
}
