import {
  activityReadPermission,
  announcePermission,
  aiAreas,
  aiAssistantPermission,
  controlPermission,
  historyReadPermission,
  pausedBy,
  peopleReadPermission,
  permissionWords,
  placesReadPermission,
  readPermission,
  type AiCanUse,
  type AiOfferInfo,
  type AppInfo,
} from "@meetsanctum/app-sdk";
import type { AgentInfo } from "@meetsanctum/auth-protocol";

import { isGivenUp } from "../app-state";
import { productName } from "../brand";
import { seenText } from "../settings-clients";

// The words Settings uses for AI agents and what they can use. The core's
// areas are permissions, so their titles are the permissions' own; a line
// under each says what it covers.

export const agentsTitle = "AI Agents";
export const canUseTitle = "What AI Agents Can Use";

/**
 * The apps that act as the household's AI assistant: those that hold
 * `ai.assistant`, and one paused while it's off, which stays in its place.
 */
export function assistantAppsOf(apps: readonly AppInfo[]) {
  return apps.filter(
    (app) =>
      app.permissions.includes(aiAssistantPermission) ||
      (app.state === "paused" &&
        pausedBy(app.requests, app.permissions).includes(
          aiAssistantPermission,
        )),
  );
}

/** Under an assistant app's name: whose app it is. */
export const assistantAppDetail = `${productName} app`;

/** After an assistant app's name, while it isn't working. */
export function assistantAppState(app: AppInfo) {
  if (app.state === "paused") return "paused";
  if (app.state === "off") return "off";
  if (isGivenUp(app)) return "not running";
  return null;
}

/** What each of the core's areas covers, under its title. */
export const areaDetail: Record<string, string> = {
  [placesReadPermission]: "AI agents need them to do anything by room",
  [controlPermission("light")]: "Seeing them too",
  [readPermission("switch")]: "Plugs too",
  [controlPermission("switch")]: "Plugs too, and what's plugged into them",
  [readPermission("sensor")]: "Such as temperature and humidity",
  [readPermission("motion")]: "Tells who's home right now",
  [readPermission("contact")]: "Tells who's home right now",
  [readPermission("button")]: "Tells who's home right now",
  [activityReadPermission]:
    "The activity log, with names only if See who lives here is on",
  [historyReadPermission]: "Up to 10 days back",
  [announcePermission]: `In ${productName}'s voice, never on a muted speaker`,
  [peopleReadPermission]: "Names, in the activity log too",
};

/**
 * The areas that tell when someone is home, or who: each asks before it
 * turns on, since an AI agent may pass on what it reads.
 */
const whosHomeReasons: Record<string, string> = {
  [readPermission("motion")]: "Motion can show when someone is home.",
  [readPermission("contact")]: "A door opening can show when someone is home.",
  [readPermission("button")]: "A remote's press can show when someone is home.",
  [activityReadPermission]:
    "What happened at home can show when someone was there.",
  [historyReadPermission]:
    "What your devices reported can show when someone was home.",
  [peopleReadPermission]:
    "It gives AI agents the names of the people who live here.",
};

export const tellsWhosHome = (area: string) =>
  Object.hasOwn(whosHomeReasons, area);

/** The question before an area that tells who's home turns on. */
export function turnOnWords(area: string) {
  const title = permissionWords(area).title;
  return {
    title: `Let AI agents ${title[0]!.toLowerCase()}${title.slice(1)}?`,
    description: `${whosHomeReasons[area]} AI agents may share what they read with the company that runs them.`,
  };
}

/** Said under each list of what AI agents can use. */
export const toldWhatsOff =
  "AI agents are told what's switched off here, so they can say so.";

/**
 * Why an offer can't be used while it's on, or none: what it needs that's
 * off, one of the core's areas or another of its app's items, and whether
 * any of that is an area, which is switched on What AI agents can use.
 */
export function missingWords(
  offer: AiOfferInfo,
  offers: readonly AiOfferInfo[],
) {
  if (offer.missing.length === 0) return undefined;
  const needs = offer.missing.map((id) => {
    const own = offers.find(
      (other) => other.app === offer.app && other.id === id,
    );
    const isArea = !own && aiAreas.includes(id);
    return {
      title: own?.title ?? permissionWords(id).title,
      isArea,
      isOff: isArea || own?.on === false,
    };
  });
  const titles = needs.map((need) => need.title);
  const list =
    titles.length === 1
      ? titles[0]
      : `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
  return {
    text: `Needs ${list}, which ${titles.length === 1 ? "is" : "are"} ${needs.every((need) => need.isOff) ? "off for AI agents" : "unavailable to AI agents"}`,
    area: needs.some((need) => need.isArea),
  };
}

/** An app's offers, and how many of them are on, such as "2 of 5 on". */
export function offersOf(canUse: AiCanUse | undefined, app: string) {
  return canUse?.offers.filter((offer) => offer.app === app) ?? [];
}

/** App settings show write actions before reads and entity types. */
export function offersByGroup(offers: readonly AiOfferInfo[]) {
  const actions: AiOfferInfo[] = [];
  const information: AiOfferInfo[] = [];
  for (const offer of offers) {
    (offer.tier === "write" ? actions : information).push(offer);
  }
  return { actions, information };
}

export const onCount = (items: readonly { on: boolean }[]) =>
  `${items.filter((item) => item.on).length} of ${items.length} on`;

const dateWords = (at: Date) =>
  at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
const timeWords = (at: Date, withSeconds = false) =>
  at.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
  });

/**
 * Who added an agent and when, then when it was last seen. Where two
 * agents share a name the time they were added tells them apart, since
 * adding one again can leave the earlier one working.
 */
export function agentDetail(
  agent: AgentInfo,
  agents: readonly AgentInfo[],
  now?: Date,
) {
  const added = new Date(agent.createdAt);
  const twins = agents.filter(
    (other) => other.id !== agent.id && other.name === agent.name,
  );
  const date = dateWords(added);
  const time = timeWords(added);
  const sharesMinute = twins.some((other) => {
    const otherAdded = new Date(other.createdAt);
    return dateWords(otherAdded) === date && timeWords(otherAdded) === time;
  });
  const when = twins.length
    ? `${date} at ${sharesMinute ? timeWords(added, true) : time}`
    : date;
  const by = agent.addedBy.name
    ? agent.addedBy.kind === "person"
      ? ` by ${agent.addedBy.name}`
      : ` from ${agent.addedBy.name}`
    : "";
  return `Added${by} on ${when} · ${seenText(agent.lastSeenAt, now)}`;
}
