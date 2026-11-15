import type { AppContext } from "@meetsanctum/app-sdk";

import { takeInLights } from "./choices.js";
import {
  followAgainFrom,
  followAll,
  followOptionsFor,
  letGoAll,
  publishAll,
  type RunForLight,
  type Timing,
} from "./lights.js";

// What natural light does while it runs, beside its job and its actions. Its
// start takes in the lights that follow it by default and publishes where
// each stands, from its own database, setting none, since that's how a
// failed update of it is undone; the job then sets them. Two changes reach
// the lights at once rather than at the next check, through a loop the
// start began, since work launched by a handler loses its access to the core
// as soon as that handler returns:
//
// - New settings (settings.changed): a new curve reaches every light.
//   Switched off, natural light lets go of every light, which keeps the
//   look it has; switched on again, every light that follows takes the
//   curve at once, whatever was set while it was off.
// - A light added to the home (device.added): it follows at once, unless
//   the household left it out.

export function createFollower(
  ctx: AppContext,
  timing: Timing,
  runForLight: RunForLight,
) {
  let isStopped = false;
  let isSettingsChanged = false;
  let isDeviceAdded = false;
  let wasOn: boolean | undefined;
  let wake: (() => void) | undefined;

  // Every light to the settings as they stand now, those it set a moment
  // ago too.
  async function takeNewSettings() {
    const options = await followOptionsFor(ctx, timing);
    const isTurnedOn = options.isOn && wasOn === false;
    if (!options.isOn && wasOn !== false) {
      await letGoAll(ctx, runForLight);
    }
    if (isTurnedOn) {
      await followAgainFrom(ctx, options.now());
    }
    wasOn = options.isOn;
    await followAll(ctx, { ...options, isDueNow: true }, runForLight);
  }

  // Lights added meanwhile, which follow unless left out.
  async function takeInNewLights() {
    const began = await takeInLights(ctx, runForLight);
    if (began.length === 0) return;
    await followAll(ctx, await followOptionsFor(ctx, timing), runForLight);
  }

  async function run() {
    while (!isStopped) {
      // One at a time: a change meanwhile runs right after.
      if (!isSettingsChanged && !isDeviceAdded) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
      if (isStopped) return;
      const settings = isSettingsChanged;
      const added = isDeviceAdded;
      isSettingsChanged = false;
      isDeviceAdded = false;
      try {
        if (added) await takeInNewLights();
        if (settings) await takeNewSettings();
      } catch (error) {
        if (!isStopped) {
          ctx.log(
            `could not follow the change (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
    }
  }

  // What start and resume publish: the lights that follow, those new
  // meanwhile included. Taking in may fail, as when the core can't list the
  // devices; the job tries again.
  async function publishStanding() {
    try {
      await takeInLights(ctx, runForLight);
    } catch (error) {
      ctx.log(
        `could not take in new lights (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const options = await followOptionsFor(ctx, timing);
    wasOn = options.isOn;
    await publishAll(ctx, options, runForLight);
  }

  return {
    async start() {
      await ctx.events.on("settings.changed", () => {
        isSettingsChanged = true;
        wake?.();
      });
      await ctx.events.on("device.added", () => {
        isDeviceAdded = true;
        wake?.();
      });
      await publishStanding();
      void run();
    },
    /** After the core restarted: all it owns, said again for the home now. */
    async resume() {
      await publishStanding();
    },
    stop() {
      isStopped = true;
      wake?.();
    },
  };
}
