// What a coordinator's path says about its serial settings. Only a profile
// sets a baud rate or flow control; an adapter guessed from the path keeps
// zigbee-herdsman's defaults.

export const zigbeeAdapters = [
  "deconz",
  "ember",
  "zstack",
  "zigate",
  "zboss",
] as const;
export type ZigbeeAdapter = (typeof zigbeeAdapters)[number];

const nabuCasaZbt2ProfileId = "nabu-casa-zbt-2";
const conbee3ProfileId = "dresden-conbee-iii";
type ZigbeeCoordinatorProfileId =
  typeof nabuCasaZbt2ProfileId | typeof conbee3ProfileId;

export type ZigbeeCoordinatorCandidate = {
  // The host's path, under /dev/serial/by-id when the device has one, so it
  // survives reboots and replugging.
  path: string;
  // The tty the path points at, such as /dev/ttyACM0.
  resolvedPath: string | null;
  label: string;
  adapter: ZigbeeAdapter | null;
  matchConfidence: "exact" | "likely" | "unknown";
  profileId: ZigbeeCoordinatorProfileId | null;
  recommended: boolean;
};

export type ZigbeeSerialSettings = {
  adapter: ZigbeeAdapter | undefined;
  baudRate?: number;
  rtscts?: boolean;
};

type ZigbeeCoordinatorProfile = {
  adapter: ZigbeeAdapter;
  baudRate?: number;
  id: ZigbeeCoordinatorProfileId;
  label: string;
  rtscts?: boolean;
};

const nabuCasaZbt2Profile: ZigbeeCoordinatorProfile = {
  adapter: "ember",
  baudRate: 460_800,
  id: nabuCasaZbt2ProfileId,
  label: "Nabu Casa ZBT-2",
  rtscts: true,
};

const conbee3Profile: ZigbeeCoordinatorProfile = {
  adapter: "deconz",
  baudRate: 115_200,
  id: conbee3ProfileId,
  label: "Dresden Elektronik ConBee III",
};

export function zigbeeCoordinatorSerialDefaults(
  path: string,
  adapter?: ZigbeeAdapter,
  profileId?: string | null,
): ZigbeeSerialSettings {
  const profile = getZigbeeCoordinatorProfile(
    profileId ?? matchZigbeeCoordinatorProfile(path).profileId,
  );
  if (profile && (!adapter || adapter === profile.adapter)) {
    return {
      adapter: profile.adapter,
      baudRate: profile.baudRate,
      rtscts: profile.rtscts,
    };
  }
  return { adapter: adapter ?? inferZigbeeCoordinatorAdapter(path) };
}

function getZigbeeCoordinatorProfile(profileId: string | null) {
  if (profileId === nabuCasaZbt2ProfileId) return nabuCasaZbt2Profile;
  if (profileId === conbee3ProfileId) return conbee3Profile;
  return null;
}

export function createZigbeeCoordinatorCandidate(
  path: string,
  resolvedPath: string | null,
): ZigbeeCoordinatorCandidate {
  const profileMatch = matchZigbeeCoordinatorProfile(path);
  const profile = profileMatch.profileId
    ? getZigbeeCoordinatorProfile(profileMatch.profileId)
    : null;
  return {
    path,
    resolvedPath,
    label: profile?.label ?? path.split("/").at(-1) ?? path,
    adapter: profile?.adapter ?? inferZigbeeCoordinatorAdapter(path) ?? null,
    matchConfidence: profileMatch.confidence,
    profileId: profile?.id ?? null,
    recommended: profileMatch.confidence === "exact",
  };
}

function inferZigbeeCoordinatorAdapter(path: string) {
  if (/zbt|skyconnect|nabu|silicon/i.test(path)) {
    return "ember";
  }
  if (/conbee|raspbee|dresden/i.test(path)) {
    return "deconz";
  }
  return undefined;
}

function matchZigbeeCoordinatorProfile(path: string): {
  confidence: "exact" | "likely" | "unknown";
  profileId: ZigbeeCoordinatorProfileId | null;
} {
  if (
    /^\/dev\/serial\/by-id\/usb-dresden_elektronik_.*ConBee_III_/i.test(path)
  ) {
    return { confidence: "exact", profileId: conbee3ProfileId };
  }
  if (/^\/dev\/serial\/by-id\/usb-Nabu_Casa_ZBT-2_/i.test(path)) {
    return { confidence: "exact", profileId: nabuCasaZbt2ProfileId };
  }
  // Not any "nabu": a SkyConnect is one too, and is not a ZBT-2.
  if (/zbt[-_ ]?2/i.test(path)) {
    return { confidence: "likely", profileId: nabuCasaZbt2ProfileId };
  }
  return { confidence: "unknown", profileId: null };
}
