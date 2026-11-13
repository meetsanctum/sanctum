import { z } from "zod";

// Places: the home and its floors, rooms and zones, which the core keeps for
// every app. Apps refer to them by id and read them with ctx.places.list()
// under `places.read`. Where the home is says more about a household than
// its rooms do, so it has a permission of its own, `places.location`.

export const placesReadPermission = "places.read";
export const placesLocationPermission = "places.location";

export type Floor = {
  id: string;
  name: string;
  /** Its height in the home: 0 for the ground floor, negative below it. */
  level: number;
};

export type Room = {
  id: string;
  name: string;
  floorId: string | null;
};

/** A group of rooms the household names, such as "Upstairs" or "Kids". */
export type Zone = {
  id: string;
  name: string;
  roomIds: string[];
};

/**
 * How the home shows temperatures, which the household sets in Settings →
 * Household: the shell and apps' pages convert as they draw, while readings
 * and forecasts stay in Celsius.
 */
export const temperatureUnits = ["celsius", "fahrenheit"] as const;
export type TemperatureUnit = (typeof temperatureUnits)[number];

export type Places = {
  /**
   * The home's name; the time zone its days run in: the one someone set,
   * or the host's while there is none, as the core's own times use; and the
   * unit it shows temperatures in, Celsius until someone changes it. It
   * stands apart from where the home is, which needs `places.location`.
   */
  home: { name: string; timeZone: string; temperatureUnit: TemperatureUnit };
  floors: Floor[];
  rooms: Room[];
  zones: Zone[];
};

/**
 * What removing a room takes with it, for the warning read first
 * (`GET /api/places/rooms/removal?id=`): its devices, which move to No room
 * and stay paired; what apps keep for it, counted by app and type from their
 * entities in the room, which they clean up on place.deleted; and the
 * workflows whose config names it.
 */
export type RoomRemoval = {
  devices: { id: string; name: string }[];
  entities: { app: string; type: string; title: string; count: number }[];
  workflows: { id: string; name: string }[];
};

/** Whether the runtime knows an IANA time zone, such as Europe/Zurich. */
export function isTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Where the home is, which the household sets; the home's days run in its time zone. */
export const homeLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /**
   * Metres above sea level, from the Dead Sea's shore to the highest peaks,
   * or null while the household has not said. Sun times count it, as
   * published tables do: the higher the home, the earlier the sun rises and
   * the later it sets.
   */
  elevation: z.number().min(-500).max(9000).nullable(),
  timeZone: z
    .string()
    .min(1)
    .max(64)
    .refine(isTimeZone, "use an IANA time zone such as Europe/Zurich"),
});
export type HomeLocation = z.infer<typeof homeLocationSchema>;
