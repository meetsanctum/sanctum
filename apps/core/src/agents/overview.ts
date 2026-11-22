import {
  permissionWords,
  type AiCanUse,
  type AiOfferInfo,
  type Availability,
  type CapabilityKind,
  type DeviceInfo,
  type DeviceType,
  type Places,
} from "@meetsanctum/app-sdk";

// What `home_overview` answers an AI agent: the home's places, the devices
// whose kinds AI agents may see, its own name, and what it can't use. What's
// offered but switched off is listed with where it's decided, so the agent
// can tell the person why, in neutral words that never invite it to change
// that. It names no moods, rooms or people there, and no ids or counts. What
// Sanctum keeps for people is listed by area, without naming actions.

export type OverviewDevice = {
  id: string;
  name: string;
  type: DeviceType;
  roomId: string | null;
  availability: Availability;
  capabilities: {
    id: string;
    kind: CapabilityKind;
    features: unknown;
    state: unknown;
  }[];
};

export type NotAllowed = {
  /** The item, as its switch names it, such as "Create a mood". */
  title: string;
  /** Where it's decided, such as "Moods' settings". */
  where: string;
  /** What it needs that's off, while it's on itself. */
  needs?: string[];
};

export type HomeOverview = {
  agent: { name: string };
  home: Places["home"];
  floors: Places["floors"];
  rooms: Places["rooms"];
  zones: Places["zones"];
  devices: OverviewDevice[];
  notAllowed: NotAllowed[];
  notForAgents: { area: string; where: string }[];
};

/** Where the core's own areas are decided. */
export const areasPage = "Settings, What AI agents can use";

// What Sanctum keeps for people, whatever is switched on.
export const notForAgents: HomeOverview["notForAgents"] = [
  {
    area: "Adding, pairing, repairing, removing, renaming or moving devices, and a sensor's own settings",
    where: "Settings, Devices",
  },
  {
    area: "Rooms, floors, zones, people and dashboards",
    where: "Settings",
  },
  {
    area: "Adding, removing, updating or going back on apps, and deleting their data",
    where: "Apps",
  },
  {
    area: "Sign-ins, pairing, clients, updates, restarts and backups",
    where: "Settings",
  },
  {
    area: "Schedules, and what a remote's presses or motion do",
    where: "The app that keeps them",
  },
  { area: "Automations", where: "The app that keeps them" },
];

// "Moods' settings", "Weather's settings".
export function settingsOf(appName: string) {
  return `${appName}${appName.endsWith("s") ? "'" : "'s"} settings`;
}

const titleOf = (id: string) => permissionWords(id).title;

export function notAllowedOf(
  canUse: AiCanUse,
  appName: (appId: string) => string | undefined,
): NotAllowed[] {
  const areas = canUse.areas
    .filter((area) => !area.on)
    .map((area) => ({ title: titleOf(area.id), where: areasPage }));
  const offers = canUse.offers.flatMap((offer): NotAllowed[] => {
    if (offer.on && offer.missing.length === 0) return [];
    const name = appName(offer.app);
    if (name === undefined) return [];
    const item: NotAllowed = { title: offer.title, where: settingsOf(name) };
    if (offer.on) item.needs = needTitles(canUse, offer);
    return [item];
  });
  return [...areas, ...offers];
}

// What an offer needs that's off, by title: an area by its permission's
// words, or another of the app's offers by its own.
export function needTitles(canUse: AiCanUse, offer: AiOfferInfo) {
  return offer.missing.map(
    (need) =>
      canUse.offers.find(
        (other) => other.app === offer.app && other.id === need,
      )?.title ?? titleOf(need),
  );
}

export function overviewDevice(device: DeviceInfo): OverviewDevice {
  return {
    id: device.id,
    name: device.name,
    type: device.shownAs ?? device.type,
    roomId: device.roomId,
    availability: device.availability,
    // Its state, without who set it: setBy names people and clients.
    capabilities: device.capabilities.map((capability) => ({
      id: capability.id,
      kind: capability.kind,
      features: capability.features,
      state: capability.state,
    })),
  };
}
