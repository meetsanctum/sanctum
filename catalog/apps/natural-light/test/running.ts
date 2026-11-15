import type { ActionDefinition, Actor } from "@meetsanctum/app-sdk";

import {
  brightnessPercent,
  clampMired,
  colorTemperatureKelvin,
  kelvinToMired,
  type CurveSettings,
} from "../src/curve.js";
import { createNaturalLightApp } from "../src/index.js";
import { defaultCurve } from "../src/settings.js";
import { sunToday } from "../src/sun.js";
import { fakeCore, zurich } from "./fake-core.js";

// What natural light's tests share: a running app on a fake core, at
// mid-morning in Zurich, and the curve's look at a moment.

export const appId = "sanctum.natural-light";
export const maya: Actor = { kind: "user", id: "maya" };
export const moods = { app: "sanctum.moods", actor: maya };
export const byHand = { app: null, actor: maya };
export const minute = 60_000;
export const lamp = { device: "lamp", capability: "light" };
export const range = { min: 153, max: 454 };
export const on = {
  on: true,
  brightness: 100,
  colorMode: "temperature" as const,
};
export const off = { ...on, on: false };

// What the curve sets a light with the fake core's range to at a moment.
export function curveAt(now: Date, curve: CurveSettings = defaultCurve) {
  const sun = sunToday(zurich, now)!;
  return {
    colorTemperature: clampMired(
      kelvinToMired(colorTemperatureKelvin(curve, sun, now)),
      range,
    ),
    brightness: brightnessPercent(curve, sun, now),
  };
}

export function running() {
  // Mid-morning in Zurich, with the curve rising towards noon.
  const clock = { now: Date.parse("2026-10-29T09:00:00Z") };
  const now = () => new Date(clock.now);
  const app = createNaturalLightApp({ now });
  const core = fakeCore(app, now);

  async function call(id: string, input: object, actor: Actor = maya) {
    const action = app.actions.find(
      (each) => each.id === id,
    ) as ActionDefinition;
    const output = await action.run(core.as(actor), action.input.parse(input));
    return action.output.parse(output);
  }

  return {
    app,
    core,
    call,
    // The app's job, as the core runs it: as the app itself.
    check: () => call("naturalLight.check", {}, { kind: "app", id: appId }),
    now,
    advance: (ms: number) => (clock.now += ms),
    target: () => core.state.entities.get("lamp/light")?.state,
    // The commands the app sent from the n-th on.
    sentFrom: (index: number) =>
      core.state.sent.slice(index).map(({ command }) => command),
  };
}
