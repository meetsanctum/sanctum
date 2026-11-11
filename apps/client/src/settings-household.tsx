import {
  temperatureUnits,
  type HomeLocation,
  type TemperatureUnit,
} from "@meetsanctum/app-sdk";
import { Button, Input } from "@meetsanctum/ui-sdk";
import { useEffect, useId, useState, type FormEvent } from "react";

import { productName } from "./brand";
import { Section } from "./components";
import { CoreError, coreJson } from "./core-fetch";

// Settings → Household: the home's name and where the home is: its latitude,
// longitude, elevation and time zone, which Weather and natural light work
// from, for every client. The elevation is optional and goes with the
// coordinates. The time zone stands on its own, so a household that keeps
// its coordinates to itself still has its clock. The suggestion from the
// home's public IP address asks services on the internet, so it comes only
// when someone presses its button, and fills the fields for them to check
// and save. The temperature unit is how the home shows temperatures, in
// rooms, sensors and Weather alike; what sensors and forecasts say stays in
// Celsius.

type Coordinates = {
  latitude: number;
  longitude: number;
  elevation: number | null;
};
type HomeInfo = {
  name: string;
  timeZone: string | null;
  coordinates: Coordinates | null;
  temperatureUnit: TemperatureUnit;
};

const unitNames: Record<TemperatureUnit, string> = {
  celsius: "Celsius",
  fahrenheit: "Fahrenheit",
};
type Suggestion = HomeLocation & { place: string | null };

// The time zones this device knows, for the field's suggestions.
const timeZones =
  typeof Intl.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("timeZone")
    : [];
const deviceTimeZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";

const label = "text-[13px] leading-[18px] font-medium text-muted-foreground";
const field =
  "h-10 bg-background text-[15px] text-foreground placeholder:text-muted-foreground md:text-[15px]";

export function HouseholdSection() {
  return (
    <Section id="settings-household" title="Household">
      <HomeForm />
    </Section>
  );
}

// What the fields hold, as typed.
type Draft = {
  name: string;
  latitude: string;
  longitude: string;
  elevation: string;
  timeZone: string;
  temperatureUnit: TemperatureUnit;
};

const numberText = (value: number | null | undefined) =>
  value === null || value === undefined ? "" : String(value);
// A field's number as typed, with a decimal point or comma; NaN when empty.
const numberOf = (text: string) =>
  text.trim() ? Number(text.trim().replace(",", ".")) : NaN;

const draftOf = (home: HomeInfo): Draft => ({
  name: home.name,
  latitude: home.coordinates ? String(home.coordinates.latitude) : "",
  longitude: home.coordinates ? String(home.coordinates.longitude) : "",
  elevation: numberText(home.coordinates?.elevation),
  // Until someone sets one, the host's applies, so none is filled in.
  timeZone: home.timeZone ?? "",
  temperatureUnit: home.temperatureUnit,
});

// Where the fields put the home: no coordinates, nor elevation, when both
// are left empty, and undefined when they do not make a place, or have no
// time zone. The elevation, in metres, is optional with them.
function whereOf(
  draft: Draft,
): Pick<HomeInfo, "timeZone" | "coordinates"> | undefined {
  const latitude = draft.latitude.trim().replace(",", ".");
  const longitude = draft.longitude.trim().replace(",", ".");
  const elevation = draft.elevation.trim().replace(",", ".");
  const timeZone = draft.timeZone.trim() || null;
  if (!latitude && !longitude) return { timeZone, coordinates: null };
  const coordinates = {
    latitude: Number(latitude),
    longitude: Number(longitude),
    elevation: elevation ? Number(elevation) : null,
  };
  const valid =
    latitude !== "" &&
    longitude !== "" &&
    Math.abs(coordinates.latitude) <= 90 &&
    Math.abs(coordinates.longitude) <= 180 &&
    (coordinates.elevation === null ||
      (coordinates.elevation >= -500 && coordinates.elevation <= 9000)) &&
    timeZone !== null;
  return valid ? { timeZone, coordinates } : undefined;
}

function HomeForm() {
  const ids = useId();
  const unitName = useId();
  const [home, setHome] = useState<HomeInfo>();
  const [draft, setDraft] = useState<Draft>();
  const [note, setNote] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [working, setWorking] = useState<"saving" | "suggesting">();

  useEffect(() => {
    let isCurrent = true;
    coreJson<HomeInfo>("/api/places/home")
      .then((answer) => {
        if (!isCurrent) return;
        setHome(answer);
        setDraft(draftOf(answer));
      })
      .catch(() => undefined);
    return () => {
      isCurrent = false;
    };
  }, []);

  if (!home || !draft) return null;

  const change =
    (key: Exclude<keyof Draft, "temperatureUnit">) => (value: string) => {
      setDraft({ ...draft, [key]: value });
      setNote(undefined);
      setProblem(undefined);
    };
  const changeUnit = (temperatureUnit: TemperatureUnit) => {
    setDraft({ ...draft, temperatureUnit });
    setNote(undefined);
    setProblem(undefined);
  };
  const where = whereOf(draft);
  const name = draft.name.trim();
  const hasCoordinates = !!(draft.latitude.trim() || draft.longitude.trim());
  const needsTimeZone = !draft.timeZone.trim() && hasCoordinates;
  const dropsElevation = !!draft.elevation.trim() && !hasCoordinates;

  const suggest = async () => {
    setWorking("suggesting");
    setNote(undefined);
    setProblem(undefined);
    try {
      const found = await coreJson<Suggestion>(
        "/api/places/home/suggest-location",
        { method: "POST", json: {} },
      );
      setDraft((current) => {
        if (!current) return current;
        // The suggested height and time zone belong to its coordinates.
        // Keep the whole location if it was edited while we waited.
        const hasLocationEdits =
          current.latitude !== draft.latitude ||
          current.longitude !== draft.longitude ||
          current.elevation !== draft.elevation ||
          current.timeZone !== draft.timeZone;
        if (hasLocationEdits) return current;
        // Without a height from Open-Meteo, the elevation of the same place
        // stays; another place's goes.
        const isSamePlace =
          numberOf(current.latitude) === found.latitude &&
          numberOf(current.longitude) === found.longitude;
        return {
          ...current,
          latitude: String(found.latitude),
          longitude: String(found.longitude),
          elevation:
            found.elevation === null && isSamePlace
              ? current.elevation
              : numberText(found.elevation),
          timeZone: found.timeZone,
        };
      });
      setNote(
        `${found.place ? `Near ${found.place}.` : "Found."} Check it, then save.`,
      );
    } catch {
      setProblem(
        "The location services did not answer. Enter the location yourself, or try again.",
      );
    } finally {
      setWorking(undefined);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (where === undefined || !name) return;
    setWorking("saving");
    setNote(undefined);
    setProblem(undefined);
    try {
      const saved = await coreJson<HomeInfo>("/api/places/home/update", {
        method: "POST",
        json: { name, ...where, temperatureUnit: draft.temperatureUnit },
      });
      setHome(saved);
      // Keep edits made while the request was in flight. The saved result
      // still becomes the baseline, so those edits remain unsaved.
      setDraft((current) => (current === draft ? draftOf(saved) : current));
      setNote("Saved.");
    } catch (error) {
      setProblem(
        error instanceof CoreError && error.code === "invalid_request"
          ? `${productName} does not know that place. Check the numbers and the time zone.`
          : "That did not work. Try again.",
      );
    } finally {
      setWorking(undefined);
    }
  };

  const unchanged =
    name === home.name &&
    draft.temperatureUnit === home.temperatureUnit &&
    where?.timeZone === home.timeZone &&
    JSON.stringify(where?.coordinates) === JSON.stringify(home.coordinates);
  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor={`${ids}-name`} className={label}>
          Name
        </label>
        <Input
          id={`${ids}-name`}
          value={draft.name}
          maxLength={60}
          onChange={(event) => change("name")(event.target.value)}
          className={field}
          required
        />
      </div>
      <div className="flex gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <label htmlFor={`${ids}-latitude`} className={label}>
            Latitude
          </label>
          <Input
            id={`${ids}-latitude`}
            inputMode="decimal"
            value={draft.latitude}
            onChange={(event) => change("latitude")(event.target.value)}
            className={field}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <label htmlFor={`${ids}-longitude`} className={label}>
            Longitude
          </label>
          <Input
            id={`${ids}-longitude`}
            inputMode="decimal"
            value={draft.longitude}
            onChange={(event) => change("longitude")(event.target.value)}
            className={field}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <label htmlFor={`${ids}-elevation`} className={label}>
            Elevation
          </label>
          <Input
            id={`${ids}-elevation`}
            inputMode="decimal"
            value={draft.elevation}
            onChange={(event) => change("elevation")(event.target.value)}
            className={field}
          />
        </div>
      </div>
      {dropsElevation && (
        <span className={`-mt-2 ${label}`}>
          The elevation goes with the latitude and longitude: without them, it
          is not saved.
        </span>
      )}
      <div className="flex flex-col gap-2">
        <label htmlFor={`${ids}-time-zone`} className={label}>
          Time zone
        </label>
        <Input
          id={`${ids}-time-zone`}
          list={`${ids}-time-zones`}
          value={draft.timeZone}
          placeholder={`For example, ${deviceTimeZone() || "Europe/Zurich"}`}
          onChange={(event) => change("timeZone")(event.target.value)}
          className={field}
        />
        {needsTimeZone && (
          <span className={label}>
            Add the time zone too: Weather and natural light need it with the
            latitude and longitude.
          </span>
        )}
        <datalist id={`${ids}-time-zones`}>
          {timeZones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      </div>
      <p className={`m-0 ${label}`}>
        Weather and natural light work from where the home is. The elevation, in
        metres above sea level, is optional: it makes sunrise and sunset a few
        minutes more exact. Leave latitude and longitude empty to keep them to
        yourselves: the time zone still sets the home’s clock.
      </p>
      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className={`mb-2 p-0 ${label}`}>Temperature unit</legend>
        <div className="flex flex-wrap gap-1">
          {temperatureUnits.map((unit) => (
            <label
              key={unit}
              className="flex h-9 cursor-pointer items-center rounded-md bg-foreground/8 px-3 text-sm font-medium has-focus-visible:ring-3 has-focus-visible:ring-ring/50 has-checked:bg-foreground has-checked:text-background"
            >
              <input
                type="radio"
                name={unitName}
                value={unit}
                checked={draft.temperatureUnit === unit}
                onChange={() => changeUnit(unit)}
                className="sr-only"
              />
              {unitNames[unit]}
            </label>
          ))}
        </div>
        <span className={label}>
          How the home shows temperatures: in rooms, sensors and Weather.
        </span>
      </fieldset>
      {(note || problem) && (
        <p
          role={problem ? "alert" : "status"}
          className={`m-0 text-sm ${problem ? "text-destructive" : ""}`}
        >
          {problem ?? note}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          disabled={!!working || where === undefined || !name || unchanged}
        >
          Save
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!!working}
          onClick={() => void suggest()}
        >
          Suggest from this network
        </Button>
      </div>
      <p className={`m-0 ${label}`}>
        The suggestion asks ipify.org and GeoJS where this network’s internet
        address is, and Open-Meteo how high that is. Nothing is saved until you
        save.
      </p>
    </form>
  );
}
