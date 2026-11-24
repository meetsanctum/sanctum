import type { CapabilityKind, SensorMeasure } from "./devices.js";

// What a device is, to the household: what it is called, "Motion sensor" or
// "Office motion sensor", and its icon in Settings. A capability kind says what one part
// of a device does; its type says what the whole device is, whatever driver
// brings it. Its driver says the type, from what its protocol tells of the
// device, and the core takes it where the device has what the type needs.
// For a driver whose protocol tells no more than the kinds, deviceTypeOf
// gives the first type in this order whose kinds a device has, so a light
// that also measures is a light, and a motion sensor that measures is a
// motion sensor.
//
// The household may show a device as another type where its own type
// lists it (`showAs`): a contact sensor as a door or a window, which no
// sensor can tell of itself. Nothing asks for it, and a device is complete
// as its own type.

type DeviceTypeDefinition = {
  id: string;
  /** What a device of this type is called while it is in no room: "Motion sensor". */
  title: string;
  /**
   * What its name calls it after its room, "Office motion sensor". A type
   * with none goes by its title in any room.
   */
  noun: string | null;
  /** The capability kinds a device of this type has, each of them. */
  needs: readonly CapabilityKind[];
  /**
   * No capability tells it from the next type with its kinds, so
   * deviceTypeOf never gives it: a driver says a device is a plug from what
   * its protocol tells.
   */
  declaredOnly?: true;
  /** The types the household may show a device of this type as instead. */
  showAs?: readonly string[];
  /**
   * A device is one only where the household shows it as one: no driver
   * may say it.
   */
  chosenOnly?: true;
};

const types = [
  { id: "light", title: "Light", noun: "light", needs: ["light"] },
  // A speaker that listens for its wake word: its microphones tell it from
  // any other media player, whether or not it plays.
  {
    id: "smart-speaker",
    title: "Smart speaker",
    noun: "speaker",
    needs: ["audio"],
  },
  // A TV box or speaker defaults to a media player even if it has a button
  // or a settings switch.
  {
    id: "media-player",
    title: "Media player",
    noun: "media player",
    needs: ["media"],
    showAs: ["tv", "speaker"],
  },
  // What a media player is, where the household says so: the TV a box
  // plays on, or a speaker that only plays.
  { id: "tv", title: "TV", noun: "TV", needs: ["media"], chosenOnly: true },
  {
    id: "speaker",
    title: "Speaker",
    noun: "speaker",
    needs: ["media"],
    chosenOnly: true,
  },
  {
    id: "plug",
    title: "Plug",
    noun: "plug",
    needs: ["switch"],
    declaredOnly: true,
  },
  { id: "switch", title: "Switch", noun: "switch", needs: ["switch"] },
  { id: "button", title: "Button", noun: "button", needs: ["button"] },
  // A motion sensor, which may measure too.
  {
    id: "motion",
    title: "Motion sensor",
    noun: "motion sensor",
    needs: ["motion"],
  },
  // A sensor that says whether what it sits on is open, which may measure
  // too.
  {
    id: "contact",
    title: "Contact sensor",
    noun: "contact sensor",
    needs: ["contact"],
    showAs: ["door", "window"],
  },
  // What a contact sensor sits on, where the household says so.
  {
    id: "door",
    title: "Door",
    noun: "door",
    needs: ["contact"],
    chosenOnly: true,
  },
  {
    id: "window",
    title: "Window",
    noun: "window",
    needs: ["contact"],
    chosenOnly: true,
  },
  { id: "sensor", title: "Sensor", noun: "sensor", needs: ["sensor"] },
  // What none of the above fits: a device with no capability Sanctum has,
  // which it cannot use. A room's name before it would promise more than
  // is known of it, so it is an unknown device wherever it is.
  { id: "unknown", title: "Unknown device", noun: null, needs: [] },
] as const satisfies readonly DeviceTypeDefinition[];

/** What a device is: one of the types' ids. */
export type DeviceType = (typeof types)[number]["id"];

/** Every type of device, in the order a device is matched against them. */
export const deviceTypes: readonly (DeviceTypeDefinition & {
  id: DeviceType;
})[] = types;

/** A type a driver may say: any but those only the household chooses. */
export type DeclaredType = Exclude<
  DeviceType,
  Extract<(typeof types)[number], { chosenOnly: true }>["id"]
>;

/** Every type a driver may say, in the order of the list. */
export const declaredTypes = deviceTypes
  .filter((each) => !each.chosenOnly)
  .map((each) => each.id) as [DeclaredType, ...DeclaredType[]];

/**
 * What a device with these capability kinds is, for a driver whose
 * protocol tells no more: the first type whose kinds it has. A plug is
 * never given, since no capability tells it from a switch; its driver says
 * it.
 */
export function deviceTypeOf(kinds: Iterable<CapabilityKind>): DeclaredType {
  const has = new Set(kinds);
  const type = deviceTypes.find(
    (each) =>
      !each.chosenOnly &&
      !each.declaredOnly &&
      each.needs.every((kind) => has.has(kind)),
  );
  // The last type needs nothing, so one always fits.
  return (type?.id ?? "unknown") as DeclaredType;
}

/**
 * Whether a device with these capability kinds may be of this type, as its
 * driver says: it has every kind the type needs. An unknown device is one
 * with no capability Sanctum uses, so only a device with none is unknown.
 */
export function fitsType(
  type: DeviceType,
  kinds: ReadonlySet<CapabilityKind>,
): boolean {
  if (type === "unknown") return kinds.size === 0;
  // A driver built before microphones were a part of their own, protocol
  // 17 and older, says a smart speaker has only its media part, so it keeps
  // its type and name until the driver says its microphones too.
  if (type === "smart-speaker" && kinds.has("media")) return true;
  const { needs } = deviceTypes.find((each) => each.id === type)!;
  return needs.every((kind) => kinds.has(kind));
}

/** What a device is called: in no room, and after a room's name. */
export type DeviceWords = { title: string; noun: string | null };

/** What a sensor that measures one thing is called, by what it measures. */
const sensorWords = {
  temperature: { title: "Temperature sensor", noun: "temperature sensor" },
  humidity: { title: "Humidity sensor", noun: "humidity sensor" },
  illuminance: { title: "Light sensor", noun: "light sensor" },
} as const satisfies Record<SensorMeasure, DeviceWords>;

/**
 * What a device of this type is called: its type's title and noun, and for
 * a sensor those of what it measures, one measure by its own words and
 * several as an environment sensor. A sensor that says no measure is a
 * sensor.
 */
export function deviceWords(
  type: DeviceType,
  measures: readonly SensorMeasure[],
): DeviceWords {
  if (type === "sensor") {
    const uniqueMeasures = [...new Set(measures)];
    if (uniqueMeasures.length > 1) {
      return { title: "Environment sensor", noun: "environment sensor" };
    }
    const measure = uniqueMeasures[0];
    if (measure !== undefined) return { ...sensorWords[measure] };
  }
  const { title, noun } = deviceTypes.find((each) => each.id === type)!;
  return { title, noun };
}

/** The types the household may show a device of this type as, besides its own. */
export function shownAsOf(type: DeviceType): DeviceType[] {
  const listed = deviceTypes.find((each) => each.id === type)?.showAs ?? [];
  return deviceTypes
    .filter((each) => listed.includes(each.id))
    .map((each) => each.id);
}

/**
 * What a device of this type is shown as: the household's choice while its
 * own type lists it, and its own type otherwise, as for a choice that no
 * longer fits or that this version does not know.
 */
export function shownType(
  own: DeviceType,
  chosen: string | null | undefined,
): DeviceType {
  return shownAsOf(own).find((each) => each === chosen) ?? own;
}

/**
 * What a device is of itself, from what it is shown as: its type where the
 * household chose none (`shownAs` null), and otherwise the one type that
 * offers the chosen one.
 */
export function ownTypeOf(
  type: DeviceType,
  shownAs: DeviceType | null,
): DeviceType {
  if (shownAs === null) return type;
  return deviceTypes.find((each) => each.showAs?.includes(shownAs))?.id ?? type;
}

/**
 * What the household may show a device as, its own type first; nothing for
 * a device whose own type lists no other.
 */
export function showAsChoices(
  type: DeviceType,
  shownAs: DeviceType | null,
): DeviceType[] {
  const own = ownTypeOf(type, shownAs);
  const others = shownAsOf(own);
  return others.length > 0 ? [own, ...others] : [];
}
