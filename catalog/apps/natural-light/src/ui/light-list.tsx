import { Button, Switch } from "@meetsanctum/ui-sdk";
import { useState } from "react";

import {
  kelvin,
  type LightRow,
  type NaturalLightView,
} from "./use-natural-light";

// The lights that take a colour temperature, from v1's lights picker: each
// with where it stands and a switch to have it follow the curve, and Resume
// for one a mood or a person paused. A refusal leaves the switch as it was
// and says so on its row.

const muted = "text-[13px] leading-[18px] font-medium text-muted-foreground";

function status(light: LightRow) {
  const { target } = light;
  if (!target) {
    return "Not following";
  }
  if (target.status === "waiting" || target.colorTemperature === null) {
    return "Waiting for the home’s location";
  }
  const look =
    target.brightness === null
      ? kelvin(target.colorTemperature)
      : `${kelvin(target.colorTemperature)} at ${target.brightness}%`;
  return target.status === "paused"
    ? "Paused until it’s switched off"
    : `Following · ${look}`;
}

export function LightList(props: { view: NaturalLightView }) {
  const { lights, loaded } = props.view;
  if (!loaded) {
    return null;
  }
  return (
    <section
      aria-labelledby="natural-light-lights"
      className="flex max-w-md flex-col gap-3"
    >
      <h2
        id="natural-light-lights"
        className="m-0 text-[17px] leading-[22px] font-medium"
      >
        Lights
      </h2>
      {lights.length === 0 ? (
        <p className={`m-0 ${muted}`}>
          No lights that change colour temperature yet.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {lights.map((light) => (
            <Row
              key={`${light.device}/${light.capability}`}
              light={light}
              view={props.view}
            />
          ))}
        </ul>
      )}
    </section>
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
    <li className="flex min-h-11 items-center gap-3">
      <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
        <span className="truncate text-sm font-medium">{light.name}</span>
        <span className={`truncate ${muted}`}>
          {failed ? "Couldn’t change this light" : status(light)}
        </span>
      </span>
      {light.target?.status === "paused" && (
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
