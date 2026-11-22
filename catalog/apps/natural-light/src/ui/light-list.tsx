import { Button, PageSection, Switch } from "@meetsanctum/ui-sdk";
import { useState } from "react";

import {
  kelvin,
  type LightRow,
  type NaturalLightView,
  type RoomLights,
} from "./use-natural-light";

// The lights that take a colour temperature, by room once the page may read
// the home's rooms, each room in a section of its own with a switch for all
// its lights. Each light has where it stands and a switch to have it follow
// the curve or leave it out, and Resume for one a mood or a person paused.
// A light someone dimmed keeps following the curve's colour, and Resume
// brings its brightness back too. Every light follows unless it is left
// out. A refusal leaves the switch as
// it was and says so on its row, or beside its room's name.

const muted = "text-[13px] leading-[18px] font-medium text-muted-foreground";

function status(light: LightRow) {
  const { target } = light;
  if (!target) {
    return "Not following";
  }
  if (target.status === "off") {
    return "Natural Light is off";
  }
  if (target.status === "waiting" || target.colorTemperature === null) {
    return "Waiting for the home’s location";
  }
  const look =
    target.brightness === null
      ? kelvin(target.colorTemperature)
      : `${kelvin(target.colorTemperature)} at ${target.brightness}%`;
  if (target.status === "dimmed") {
    return `Following · ${kelvin(target.colorTemperature)} at your brightness`;
  }
  return target.status === "paused"
    ? "Paused until it’s switched off"
    : `Following · ${look}`;
}

/** How many of a room's lights follow, in words. */
export function roomWords(lights: readonly LightRow[]) {
  const following = lights.filter((light) => light.target !== null).length;
  if (following === 0) return "Not following";
  if (following === lights.length) {
    return lights.length === 1
      ? "Its light follows"
      : `All ${lights.length} lights follow`;
  }
  return `${following} of ${lights.length} lights follow${following === 1 ? "s" : ""}`;
}

export function LightList(props: { view: NaturalLightView }) {
  const { view } = props;
  if (!view.loaded) {
    return null;
  }
  if (view.lights.length === 0) {
    return (
      <PageSection id="natural-light-lights" title="Lights">
        <p className={`m-0 px-2.5 py-2 ${muted}`}>
          No lights that change colour temperature yet.
        </p>
      </PageSection>
    );
  }
  if (!view.rooms) {
    return (
      <PageSection
        id="natural-light-lights"
        title="Lights"
        className="max-w-md"
      >
        <Rows lights={view.lights} view={view} />
      </PageSection>
    );
  }
  return (
    <div className="flex max-w-md shrink-0 flex-col gap-5">
      {view.rooms.map((room) => (
        <Room key={room.id ?? ""} room={room} view={view} />
      ))}
    </div>
  );
}

// A room's lights, under its name with how many follow and a switch for
// them all: on while any of them follows. Switching it has every light in
// the room follow, or leaves them all out.
function Room(props: { room: RoomLights; view: NaturalLightView }) {
  const { room, view } = props;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const following = room.lights.some((light) => light.target !== null);

  async function change(follow: boolean) {
    setBusy(true);
    setFailed(false);
    try {
      setFailed((await view.followRoom(room, follow)) > 0);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const id = `natural-light-room-${room.id ?? "none"}`;
  return (
    <PageSection
      id={id}
      title={room.name}
      hint={failed ? "Couldn’t change every light" : roomWords(room.lights)}
      action={
        <Switch
          aria-label={`Lights in ${room.name} follow natural light`}
          checked={following}
          disabled={busy}
          onCheckedChange={(checked) => void change(checked)}
        />
      }
    >
      <Rows lights={room.lights} view={view} />
    </PageSection>
  );
}

function Rows(props: { lights: readonly LightRow[]; view: NaturalLightView }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
      {props.lights.map((light) => (
        <Row
          key={`${light.device}/${light.capability}`}
          light={light}
          view={props.view}
        />
      ))}
    </ul>
  );
}

function Row(props: { light: LightRow; view: NaturalLightView }) {
  const { light, view } = props;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const following = light.target !== null;

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setFailed(false);
    try {
      await work();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex min-h-14 items-center gap-3 rounded-sm px-2.5 py-2">
      <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
        <span className="truncate text-sm font-medium">{light.name}</span>
        <span className={`truncate ${muted}`}>
          {failed ? "Couldn’t change this light" : status(light)}
        </span>
      </span>
      {(light.target?.status === "paused" ||
        light.target?.status === "dimmed") && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void run(() => view.resume(light))}
        >
          Resume
        </Button>
      )}
      <Switch
        aria-label={`${light.name} follows natural light`}
        checked={following}
        disabled={busy}
        onCheckedChange={(checked) =>
          void run(() => view.follow(light, checked))
        }
      />
    </li>
  );
}
