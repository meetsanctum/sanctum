import { homeLocationSchema, type HomeLocation } from "@meetsanctum/app-sdk";
import { z } from "zod";

// A suggestion for where the home is, from its public IP address, ported
// from v1's location-detection.ts: ipify tells the address, GeoJS where it
// is and Open-Meteo how high that is. It asks services on the internet, so
// the core asks only when an admin presses the button in Settings →
// Household, and it saves nothing: the admin checks the suggestion and
// saves it. Without Open-Meteo's answer it suggests no elevation, which is
// optional.

export type LocationSuggestion = HomeLocation & {
  // Where the address is, such as "Zurich, Switzerland", when GeoJS says.
  place: string | null;
};

const ipify = z.object({ ip: z.string().min(1).max(64) });
const geojs = z.object({
  city: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  latitude: z.coerce.number(),
  longitude: z.coerce.number(),
  timezone: z.string(),
});
const openMeteo = z.object({ elevation: z.array(z.number()).min(1) });

const defaultTimeoutMs = 5_000;

export async function suggestLocation(
  fetcher: typeof fetch,
  timeoutMs = defaultTimeoutMs,
): Promise<LocationSuggestion> {
  const address = await getJson(
    fetcher,
    "https://api.ipify.org?format=json",
    timeoutMs,
  );
  const { ip } = ipify.parse(address);
  const found = geojs.parse(
    await getJson(
      fetcher,
      `https://get.geojs.io/v1/ip/geo/${encodeURIComponent(ip)}.json`,
      timeoutMs,
    ),
  );
  const location = homeLocationSchema.parse({
    latitude: found.latitude,
    longitude: found.longitude,
    elevation: await elevationAt(fetcher, found, timeoutMs),
    timeZone: found.timezone,
  });
  const place = [found.city, found.country].filter(Boolean).join(", ");
  return { ...location, place: place || null };
}

// The ground's height at a place, to the metre, from Open-Meteo's elevation
// model, or null when it does not answer or answers out of range.
async function elevationAt(
  fetcher: typeof fetch,
  at: { latitude: number; longitude: number },
  timeoutMs: number,
) {
  const url = new URL("https://api.open-meteo.com/v1/elevation");
  url.searchParams.set("latitude", String(at.latitude));
  url.searchParams.set("longitude", String(at.longitude));
  try {
    const [metres] = openMeteo.parse(
      await getJson(fetcher, url.toString(), timeoutMs),
    ).elevation;
    return homeLocationSchema.shape.elevation.parse(Math.round(metres!));
  } catch {
    return null;
  }
}

async function getJson(fetcher: typeof fetch, url: string, timeoutMs: number) {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`${new URL(url).host} answered ${response.status}`);
  }
  return response.json();
}
