import {
  isActionError,
  type AppContext,
  type DeviceInfo,
} from "@meetsanctum/app-sdk";
import { isDeepStrictEqual } from "node:util";

import { takeInLights } from "./choices.js";
import {
  followAgainFrom,
  followAll,
  followDevice,
  followOptionsFor,
  letGoAll,
  publishAll,
  rememberLightChanges,
  type LightChange,
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
// - Where the home is (location.changed): the curve there reaches every
//   light, and the rooms' buttons show once the home has a location.
// - A light added to the home (device.added): it follows at once, unless
//   the household left it out.
// - A light that changed or went (device.changed, device.removed): where it
//   stands and its room's button say so at once, as when a mood pauses it,
//   and one someone let go of takes the curve. One that answers again after
//   being offline, as a bulb behind a wall switch does, counts as switched
//   off and on: any pause or dim ends and it takes the curve at once.

export function createFollower(
  ctx: AppContext,
  timing: Timing,
  runForLight: RunForLight,
) {
  let isStopped = false;
  let isSettingsChanged = false;
  let isDeviceAdded = false;
  let isLocationChanged = false;
  // The devices that changed meanwhile, and the rooms they were and are in.
  const changed = new Map<string, Map<string, LightChange>>();
  const changedRooms = new Set<string | null>();
  // Those among them that answered again after being offline.
  const cameBack = new Map<string, Date>();
  // A rejected command restores its preceding state and emits a change.
  // Do not turn that same state into another immediate attempt; the job
  // retries it, or a different device state starts a new attempt.
  const seen = new Map<string, DeviceInfo>();
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

  // The curve where the home is now, for every light and every room.
  async function takeNewLocation() {
    const options = await followOptionsFor(ctx, timing);
    await followAll(ctx, { ...options, isDueNow: true }, runForLight);
    await publishRooms(ctx, options);
  }

  // Lights added meanwhile, which follow unless left out.
  async function takeInNewLights() {
    const began = await takeInLights(ctx, runForLight);
    const options = await followOptionsFor(ctx, timing);
    if (began.length > 0) await followAll(ctx, options, runForLight);
    await publishRooms(ctx, options);
  }

  // Lights that changed meanwhile, and their rooms' buttons.
  async function takeChanges(
    devices: ReadonlyMap<string, ReadonlyMap<string, LightChange>>,
    rooms: readonly (string | null)[],
    back: ReadonlyMap<string, Date>,
  ) {
    const options = await followOptionsFor(ctx, timing);
    for (const [deviceId, changes] of devices) {
      let device: DeviceInfo | null;
      try {
        device = await ctx.devices.state(deviceId);
      } catch (error) {
        if (!isActionError(error) || error.code !== "not_found") throw error;
        device = null;
      }
      if (device) {
        if (
          !back.has(deviceId) &&
          isDeepStrictEqual(seen.get(deviceId), device)
        ) {
          continue;
        }
        seen.set(deviceId, device);
      } else {
        seen.delete(deviceId);
      }
      // One light that can't be set leaves the others' changes, and their
      // rooms' buttons, to go on.
      try {
        await followDevice(
          ctx,
          deviceId,
          options,
          runForLight,
          back.get(deviceId),
          changes,
        );
      } catch (error) {
        ctx.log(
          `could not follow ${device?.name ?? deviceId} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    await publishRooms(ctx, options, { rooms });
  }

  const isAsked = () =>
    isSettingsChanged || isLocationChanged || isDeviceAdded || changed.size > 0;

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
      const moved = isLocationChanged;
      const devices = new Map(changed);
      const back = new Map(cameBack);
      const rooms = [...changedRooms];
      isSettingsChanged = false;
      isDeviceAdded = false;
      isLocationChanged = false;
      changed.clear();
      cameBack.clear();
      changedRooms.clear();
      try {
        if (added) await takeInNewLights();
        if (devices.size > 0) await takeChanges(devices, rooms, back);
        if (settings) await takeNewSettings();
        else if (moved) await takeNewLocation();
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

  function heard(device: DeviceInfo, before?: DeviceInfo) {
    const changes = changed.get(device.id) ?? new Map<string, LightChange>();
    const now = timing.now();
    if (before) rememberLightChanges(changes, before, now);
    rememberLightChanges(changes, device, now);
    changed.set(device.id, changes);
    changedRooms.add(device.roomId);
    if (before) changedRooms.add(before.roomId);
    if (
      before?.availability === "offline" &&
      device.availability !== "offline"
    ) {
      cameBack.set(device.id, now);
    }
    wake?.();
  }

  return {
    async start() {
      await ctx.events.on("settings.changed", () => {
        isSettingsChanged = true;
        wake?.();
      });
      await ctx.events.on("location.changed", () => {
        isLocationChanged = true;
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
