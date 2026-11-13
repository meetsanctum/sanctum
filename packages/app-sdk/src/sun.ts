import type { HomeLocation } from "./places.js";
import type { SunDay, SunTimes } from "./weather.js";

// The sun around the home's day: the state of the standard `sun` type,
// worked out here so that every app that needs sun times has the same ones
// without reading another app. Weather publishes it; natural light works it
// out for itself.
//
// The times are NOAA's Solar Calculator's
// (https://gml.noaa.gov/grad/solcalc/), which match published tables to
// within seconds. Each day is worked out around the home's local noon, so
// its times are those of the home's own days, whatever the host's time zone.
//
// It counts the home's elevation, as published tables do: from higher up the
// horizon dips, so the sun rises earlier and sets later, by about five
// minutes at 500 m. A home below sea level counts as at it.

/** Yesterday's, today's and tomorrow's sun at the home, as the `sun` type keeps it. */
export function sunTimes(location: HomeLocation, now: Date): SunTimes {
  const date = localDate(location.timeZone, now);
  return {
    date,
    timeZone: location.timeZone,
    days: [-1, 0, 1].map((offset) =>
      sunOn(location, addLocalDays(date, offset)),
    ),
  };
}

// One local day's sunrise, sunset and solar noon: the first time the sun
// comes up and the last time it goes down between the solar midnights either
// side of its noon. A sunrise or sunset that does not happen, as in a polar
// summer or winter, is null.
function sunOn(location: HomeLocation, date: string): SunDay {
  const { latitude, longitude } = location;
  const localNoon = julianDay(zonedDateToUtc(date, 12, 0, location.timeZone));
  const noon = meridianTransit(localNoon, longitude, 0);
  const crossings = horizonCrossings(
    meridianTransit(noon - 0.5, longitude, 180),
    meridianTransit(noon + 0.5, longitude, 180),
    sunHeight(latitude, longitude, horizonAltitude(location.elevation)),
  );
  const rises = crossings.filter((crossing) => crossing.rising);
  const sets = crossings.filter((crossing) => !crossing.rising);
  return {
    date,
    sunrise: iso(rises[0]?.jd ?? null),
    sunset: iso(sets.at(-1)?.jd ?? null),
    solarNoon: iso(noon)!,
  };
}

// How high the sun's centre is, in degrees, as it rises or sets: refraction
// lifts it 34′ and its upper edge shows 16′ before its centre, and from
// higher up the horizon dips, by 2.076′ times the square root of the height
// in metres.
function horizonAltitude(elevation: number | null) {
  return -0.833 - (2.076 * Math.sqrt(Math.max(0, elevation ?? 0))) / 60;
}

// How far the sun is above `horizon` at a Julian day, as the difference of
// their sines: positive while it is up.
function sunHeight(latitude: number, longitude: number, horizon: number) {
  const lat = radians(latitude);
  return (jd: number) => {
    const sun = sunAt(jd);
    return (
      Math.sin(lat) * Math.sin(sun.declination) +
      Math.cos(lat) *
        Math.cos(sun.declination) *
        Math.cos(radians(hourAngle(jd, longitude, sun))) -
      Math.sin(radians(horizon))
    );
  };
}

type Crossing = { jd: number; rising: boolean };

// Every time the sun crosses the horizon between two Julian days: it checks
// the sun's height every quarter of an hour and halves each quarter in which
// the sun changed sides. Going by its height at each instant, rather than
// solving for the hour angle with noon's declination, keeps the crossings at
// the edge of a polar summer, on days when noon's declination says there are
// none, and near the poles, where the sun can come up and go down again on
// one side of noon. A graze of the horizon shorter than a quarter of an hour
// can go unseen.
function horizonCrossings(
  from: number,
  to: number,
  height: (jd: number) => number,
) {
  const crossings: Crossing[] = [];
  const steps = Math.ceil((to - from) * 96);
  let start = from;
  let isUp = height(from) > 0;
  for (let step = 1; step <= steps; step++) {
    const end = from + ((to - from) * step) / steps;
    if (height(end) > 0 !== isUp) {
      crossings.push({ jd: bisect(start, end, height, isUp), rising: !isUp });
      isUp = !isUp;
    }
    start = end;
  }
  return crossings;
}

// When the sun changes sides between two Julian days, by halving the time
// between them; a tenth of a second is enough for whole-second times.
function bisect(
  start: number,
  end: number,
  height: (jd: number) => number,
  isUpAtStart: boolean,
) {
  let before = start;
  let after = end;
  while ((after - before) * dayMs > 100) {
    const middle = (before + after) / 2;
    if (height(middle) > 0 === isUpAtStart) before = middle;
    else after = middle;
  }
  return (before + after) / 2;
}

// Solar noon (0 degrees) or midnight (180 degrees) nearest `start`, as a
// Julian day. The equation of time settles within a second in three guesses.
function meridianTransit(start: number, longitude: number, target: 0 | 180) {
  let jd = start;
  for (let guess = 0; guess < 3; guess++) {
    const sun = sunAt(jd);
    jd += wrapDegrees(target - hourAngle(jd, longitude, sun)) / 360;
  }
  return jd;
}

// The sun's hour angle at a longitude, in degrees from the meridian: its
// true solar time, from the Julian day's UTC time and the equation of time.
function hourAngle(jd: number, longitude: number, sun: Sun) {
  const utcMinutes = mod(jd + 0.5, 1) * 1440;
  return (utcMinutes + sun.equationOfTime + 4 * longitude) / 4 - 180;
}

type Sun = {
  /** In radians. */
  declination: number;
  /** In minutes: how far true solar time runs ahead of mean solar time. */
  equationOfTime: number;
};

// Where the sun is at a Julian day, from NOAA's Solar Calculator, after Jean
// Meeus's Astronomical Algorithms.
function sunAt(jd: number): Sun {
  const t = (jd - 2451545) / 36525; // Julian centuries since J2000.0
  const meanLongitude = radians(
    mod(280.46646 + t * (36000.76983 + t * 0.0003032), 360),
  );
  const meanAnomaly = radians(357.52911 + t * (35999.05029 - 0.0001537 * t));
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const centre =
    Math.sin(meanAnomaly) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnomaly) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnomaly) * 0.000289;
  const node = radians(125.04 - 1934.136 * t);
  const apparentLongitude = radians(
    degrees(meanLongitude) + centre - 0.00569 - 0.00478 * Math.sin(node),
  );
  const meanObliquity =
    23 +
    (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = radians(meanObliquity + 0.00256 * Math.cos(node));
  const y = Math.tan(obliquity / 2) ** 2;
  const e = eccentricity;
  const l = meanLongitude;
  const m = meanAnomaly;
  return {
    declination: Math.asin(Math.sin(obliquity) * Math.sin(apparentLongitude)),
    equationOfTime:
      4 *
      degrees(
        y * Math.sin(2 * l) -
          2 * e * Math.sin(m) +
          4 * e * y * Math.sin(m) * Math.cos(2 * l) -
          0.5 * y * y * Math.sin(4 * l) -
          1.25 * e * e * Math.sin(2 * m),
      ),
  };
}

const dayMs = 86_400_000;
const unixEpoch = 2440587.5; // as a Julian day

const julianDay = (date: Date) => date.getTime() / dayMs + unixEpoch;

// To the second, as published tables give them.
const iso = (jd: number | null) =>
  jd === null
    ? null
    : new Date(Math.round((jd - unixEpoch) * 86_400) * 1000).toISOString();

const radians = (value: number) => (value * Math.PI) / 180;
const degrees = (value: number) => (value * 180) / Math.PI;
const mod = (value: number, by: number) => ((value % by) + by) % by;
// Into -180° to 180°.
const wrapDegrees = (value: number) => mod(value + 180, 360) - 180;

/** The date in a time zone, such as 2026-10-29. */
export function localDate(timeZone: string, date: Date) {
  const parts = localDateParts(date, timeZone);
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

/** The local date some days after another, such as 2026-11-01 one day after 2026-10-31. */
export function addLocalDays(date: string, days: number) {
  const { day, month, year } = parseLocalDate(date);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return [
    String(value.getUTCFullYear()).padStart(4, "0"),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** The instant of a local date and time in a time zone, across daylight saving changes. */
export function zonedDateToUtc(
  date: string,
  hour: number,
  minute: number,
  timeZone: string,
) {
  const { day, month, year } = parseLocalDate(date);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const first = localAsUtc - timeZoneOffsetMs(new Date(localAsUtc), timeZone);
  return new Date(localAsUtc - timeZoneOffsetMs(new Date(first), timeZone));
}

function parseLocalDate(date: string) {
  const [yearText, monthText, dayText] = date.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    throw new Error(`Invalid local date: ${date}`);
  }
  return { day, month, year };
}

function localDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "numeric",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  return {
    day: partNumber(parts, "day"),
    month: partNumber(parts, "month"),
    year: partNumber(parts, "year"),
  };
}

function timeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  const utc = Date.UTC(
    partNumber(parts, "year"),
    partNumber(parts, "month") - 1,
    partNumber(parts, "day"),
    partNumber(parts, "hour") % 24,
    partNumber(parts, "minute"),
    partNumber(parts, "second"),
  );
  return utc - date.getTime();
}

function partNumber(parts: Intl.DateTimeFormatPart[], type: string) {
  const value = parts.find((part) => part.type === type)?.value;
  return Number(value);
}
