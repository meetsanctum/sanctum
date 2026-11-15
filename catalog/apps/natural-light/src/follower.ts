import type { AppContext } from "@meetsanctum/app-sdk";

import { takeInLights } from "./choices.js";
import {
  followAgainFrom,
  followAll,
  followDevice,
  followOptionsFor,
  letGoAll,
  publishAll,
  type RunForLight,
  type Timing,
} from "./lights.js";
import { publishRooms } from "./rooms.js";

// What natural light does while it runs, beside its job and its actions. Its
// start takes in the lights that follow it by default and publishes where
// each stands and each room's button, from its own database, setting none,
// since that's how a failed update of it is undone; the job then sets them.
// Changes reach the lights and the buttons at once rather than at the next
// check, through a loop the start began, since work launched by a handler
// loses its access to the core as soon as that handler returns:
//
// - New settings (settings.changed): a new curve reaches every light.
//   Switched off, natural light lets go of every light, which keeps the
//   look it has, and its room buttons go; switched on again, every light
//   that follows takes the curve at once, whatever was set while it was off.
// - A light added to the home (device.added): it follows at once, unless
//   the household left it out.
// - A light that changed or went (device.changed, device.removed): where it
//   stands and its room's button say so at once, as when a mood pauses it,
//   and one someone let go of takes the curve.

export function createFollower(
  ctx: AppContext,
  timing: Timing,
  runForLight: RunForLight,
) {
  let isStopped = false;
  let isSettingsChanged = false;
  let isDeviceAdded = false;
  // The devices that changed meanwhile, and the rooms they were and are in.
  const changed = new Set<string>();
  const changedRooms = new Set<string | null>();
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
    await publishRooms(ctx, options);
  }

  // Lights added meanwhile, which follow unless left out.
  async function takeInNewLights() {
    const began = await takeInLights(ctx, runForLight);
    if (began.length === 0) return;
    const options = await followOptionsFor(ctx, timing);
    await followAll(ctx, options, runForLight);
    await publishRooms(ctx, options);
  }

  // Lights that changed meanwhile, and their rooms' buttons.
  async function takeChanges(
    devices: readonly string[],
    rooms: readonly (string | null)[],
  ) {
    const options = await followOptionsFor(ctx, timing);
    for (const device of devices) {
      await followDevice(ctx, device, options, runForLight);
    }
    await publishRooms(ctx, options, { rooms });
  }

  const isAsked = () => isSettingsChanged || isDeviceAdded || changed.size > 0;

  async function run() {
    while (!isStopped) {
      // One at a time: a change meanwhile runs right after.
      if (!isAsked()) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
      if (isStopped) return;
      const settings = isSettingsChanged;
      const added = isDeviceAdded;
      const devices = [...changed];
      const rooms = [...changedRooms];
      isSettingsChanged = false;
      isDeviceAdded = false;
      changed.clear();
      changedRooms.clear();
      try {
        if (added) await takeInNewLights();
        if (devices.length > 0) await takeChanges(devices, rooms);
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
  // meanwhile included, and each room's button. Taking in may fail, as when
  // the core can't list the devices; the job tries again.
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
    await publishRooms(ctx, options, { always: true });
  }

  function heard(
    device: { id: string; roomId: string | null },
    before?: { roomId: string | null },
  ) {
    changed.add(device.id);
    changedRooms.add(device.roomId);
    if (before) changedRooms.add(before.roomId);
    wake?.();
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
      await ctx.events.on("device.changed", ({ device, before }) =>
        heard(device, before),
      );
      await ctx.events.on("device.removed", ({ device }) => heard(device));
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
