import {
  ActionError,
  isActionError,
  type AppContext,
  type CapabilityInfo,
  type DeviceInfo,
  type LightCommand,
  type LightState,
} from "@meetsanctum/app-sdk";
import { and, eq } from "drizzle-orm";

import {
  brightnessPercent,
  clampMired,
  colorTemperatureKelvin,
  kelvinToMired,
  type CurveSettings,
} from "./curve.js";
import { followedLights, type Look } from "./schema.js";
import { curveOf } from "./settings.js";
import { sunToday, type HomeSun } from "./sun.js";
import { targetKey, targetType, type TargetState } from "./target.js";

// Lights following the curve, on the core's devices. An app can neither
// change a light's own turn-on command nor pause it from the core's command
// routes, so:
//
// - A light that is off holds the curve's look in the core, as an "off"
//   that says what it comes back at, so switching it on brings it back at
//   the curve, whoever switches it.
// - Whether it is paused is read from who last set it: a light that is on,
//   which a mood, a person or another app last set to a look of their own,
//   is paused until it is switched off or on. Switching it off or on alone,
//   or a look that is natural light's own (a mood preview putting the light
//   back), pauses nothing.
// - Every check brings lights that follow it to the curve: one that is on
//   every 5 minutes as the curve moves, one that is off every 15, and
//   either at once when someone else switched it.

export type LightCapability = Extract<CapabilityInfo, { kind: "light" }>;
export type Light = { device: DeviceInfo; capability: LightCapability };
type Followed = typeof followedLights.$inferSelect;

export type RunForLight = <T>(
  device: string,
  capability: string,
  work: () => Promise<T>,
) => Promise<T>;

/**
 * Calls for one light finish in order, the job and a new curve's included, so a
 * delayed check cannot undo a pause or publish a target after following stops.
 */
export function createRunForLight(): RunForLight {
  const pending = new Map<string, Promise<unknown>>();
  return async (device, capability, work) => {
    const key = `${device}/${capability}`;
    const result = (pending.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(work);
    pending.set(key, result);
    try {
      return await result;
    } finally {
      if (pending.get(key) === result) pending.delete(key);
    }
  };
}

/** How natural light keeps time, which tests may change. */
export type Timing = { now: () => Date; activeMs: number; offMs: number };

/**
 * What one call follows: its timing, and the curve as the household set it.
 * `isDueNow` has every light take it now, as once the household changes it.
 */
export type FollowOptions = Timing & {
  curve: CurveSettings;
  isDueNow?: boolean;
};

/**
 * The options for one call, with the curve as its settings stand now.
 */
export async function followOptionsFor(
  ctx: AppContext,
  timing: Timing,
): Promise<FollowOptions> {
  return { ...timing, curve: curveOf(await ctx.settings.get()) };
}

/** A light natural light can set: one that takes a colour temperature. */
export const takesColorTemperature = (
  capability: CapabilityInfo,
): capability is LightCapability =>
  capability.kind === "light" && capability.features.colorTemperature !== null;

/** What the curve sets a light to now, within what it can show. */
export function lookFor(
  curve: CurveSettings,
  sun: HomeSun,
  capability: LightCapability,
  now: Date,
): Look | null {
  const range = capability.features.colorTemperature;
  if (!range) {
    return null;
  }
  const look: Look = {
    colorTemperature: clampMired(
      kelvinToMired(colorTemperatureKelvin(curve, sun, now)),
      range,
    ),
  };
  if (capability.features.brightness) {
    look.brightness = brightnessPercent(curve, sun, now);
  }
  return look;
}

// Asks for a look, which pauses: a brightness, a colour or a colour
// temperature, not on or off alone.
const asksLook = (asked: Partial<LightState>) =>
  (asked.brightness ?? 0) > 0 ||
  asked.colorTemperature !== undefined ||
  asked.hue !== undefined;

// A look natural light set itself, such as a mood preview putting the light
// back as it was.
const isOwnLook = (asked: Partial<LightState>, applied: Look | null) =>
  applied !== null &&
  asked.hue === undefined &&
  (asked.colorTemperature === undefined ||
    asked.colorTemperature === applied.colorTemperature) &&
  (asked.brightness === undefined || asked.brightness === applied.brightness);

function hasEndedPause(
  row: Pick<Followed, "pausedAt">,
  capability: LightCapability,
) {
  return (
    row.pausedAt !== null &&
    (capability.state?.on === false ||
      (capability.setBy !== null &&
        Date.parse(capability.setBy.at) > row.pausedAt.getTime() &&
        capability.setBy.asked.on !== undefined))
  );
}

/** Whether a light that follows the curve is paused now. */
export function isPaused(
  row: Pick<Followed, "since" | "pausedAt" | "applied">,
  capability: LightCapability,
  appId: string,
) {
  if (capability.state?.on !== true) {
    return false;
  }
  const { setBy } = capability;
  const setAt = setBy ? Date.parse(setBy.at) : 0;
  if (row.pausedAt && !hasEndedPause(row, capability)) {
    return true;
  }
  return (
    setBy !== null &&
    setBy.app !== appId &&
    setAt > row.since.getTime() &&
    asksLook(setBy.asked) &&
    !isOwnLook(setBy.asked, row.applied)
  );
}

// A check that comes a moment before a light is due still counts, so jobs
// on a 5-minute beat set it every 5 minutes, not every 10.
const leewayMs = 30_000;

function showsLook(state: LightState | null, look: Look) {
  return (
    state?.colorMode === "temperature" &&
    state.colorTemperature === look.colorTemperature &&
    (look.brightness === undefined || state.brightness === look.brightness)
  );
}

/** What to send a light that follows the curve now, if anything. */
export function commandFor(
  light: Light,
  row: Pick<Followed, "appliedAt">,
  look: Look,
  options: {
    appId: string;
    now: Date;
    activeMs: number;
    offMs: number;
    isDueNow?: boolean;
  },
  force = false,
): LightCommand | null {
  const { device, capability } = light;
  const state = capability.state;
  if (!state || device.availability === "offline") {
    return null;
  }
  if (showsLook(state, look)) {
    return null;
  }
  // A new curve replaces the pending look; a periodic check waits for it.
  if (!force && !options.isDueNow && capability.sync === "pending") {
    return null;
  }
  const every = state.on ? options.activeMs : options.offMs;
  const isDue =
    force ||
    options.isDueNow === true ||
    capability.setBy?.app !== options.appId ||
    !row.appliedAt ||
    options.now.getTime() - row.appliedAt.getTime() + leewayMs >= every;
  if (!isDue) {
    return null;
  }
  return state.on ? { ...look } : { on: false, ...look };
}

/** The row of a light that follows the curve. */
export const followed = (device: string, capability: string) =>
  and(
    eq(followedLights.deviceId, device),
    eq(followedLights.capabilityId, capability),
  );

// Where a light stands, with the look the curve gives it now.
const targetOf = (
  light: Light,
  look: Look | null,
  status: TargetState["status"],
): TargetState => ({
  device: light.device.id,
  capability: light.capability.id,
  status: look ? status : "waiting",
  colorTemperature: look?.colorTemperature ?? null,
  brightness: look?.brightness ?? null,
});

/** Where one light that follows the curve stands now, without setting it. */
export function standing(
  light: Light,
  row: Followed,
  sun: HomeSun | null,
  options: FollowOptions,
  appId: string,
): TargetState {
  const look = sun
    ? lookFor(options.curve, sun, light.capability, options.now())
    : null;
  return targetOf(
    light,
    look,
    isPaused(row, light.capability, appId) ? "paused" : "following",
  );
}

async function publish(ctx: AppContext, light: Light, state: TargetState) {
  await ctx.entities.publish({
    type: targetType.id,
    key: targetKey(light.device.id, light.capability.id),
    name: light.device.name,
    state,
  });
}

/**
 * Brings one light that follows the curve to it, or leaves it while it is
 * paused, and publishes where it stands. `force` sends the curve's look at
 * once, as following or resuming a light does.
 */
export async function followOne(
  ctx: AppContext,
  light: Light,
  row: Followed,
  sun: HomeSun | null,
  options: FollowOptions,
  force = false,
): Promise<TargetState> {
  const { device, capability } = light;
  const now = options.now();
  const look = sun ? lookFor(options.curve, sun, capability, now) : null;
  const target = (status: TargetState["status"]) =>
    targetOf(light, look, status);
  if (hasEndedPause(row, capability)) {
    // Switched since the pause, which ends here, before natural light's next
    // command takes the switch's place as who set the light last.
    await ctx.storage.db
      .update(followedLights)
      .set({ pausedAt: null })
      .where(followed(device.id, capability.id));
    row = { ...row, pausedAt: null };
  }
  if (!look) {
    await publish(ctx, light, target("waiting"));
    return target("waiting");
  }
  if (isPaused(row, capability, ctx.appId)) {
    await publish(ctx, light, target("paused"));
    return target("paused");
  }
  const command = commandFor(
    light,
    row,
    look,
    { ...options, appId: ctx.appId, now },
    force,
  );
  if (command) {
    try {
      await ctx.devices.command({
        device: device.id,
        capability: capability.id,
        command,
      });
      await ctx.storage.db
        .update(followedLights)
        .set({ applied: look, appliedAt: now })
        .where(followed(device.id, capability.id));
    } catch (error) {
      // Asked for now, the caller hears of it; otherwise the next check
      // tries again.
      if (force) {
        throw error;
      }
      ctx.log(`could not set ${device.name} (${describe(error)})`);
    }
  } else if (
    showsLook(capability.state, look) &&
    (row.applied?.colorTemperature !== look.colorTemperature ||
      row.applied?.brightness !== look.brightness)
  ) {
    // Already at the curve: it counts as natural light's own look, so
    // putting it back after a mood preview pauses nothing.
    await ctx.storage.db
      .update(followedLights)
      .set({ applied: look })
      .where(followed(device.id, capability.id));
  }
  await publish(ctx, light, target("following"));
  return target("following");
}

/** The sun on the home's day, or none until the home has a location. */
export async function homeSun(ctx: AppContext, now: Date) {
  const location = await ctx.places.location();
  return location ? sunToday(location, now) : null;
}

/** One light, by its device and capability, as the actor behind the call sees it. */
export async function lightOf(
  ctx: AppContext,
  deviceId: string,
  capabilityId: string,
): Promise<Light> {
  const device = await ctx.devices.state(deviceId);
  const capability = device.capabilities.find(
    (each) => each.id === capabilityId,
  );
  if (!capability || capability.kind !== "light") {
    throw new ActionError("not_found");
  }
  return { device, capability };
}

export async function followedRow(
  ctx: AppContext,
  deviceId: string,
  capabilityId: string,
) {
  return ctx.storage.db
    .select()
    .from(followedLights)
    .where(followed(deviceId, capabilityId))
    .get();
}

/** Stops following a light, and takes its entity out of the home. */
export async function forget(
  ctx: AppContext,
  deviceId: string,
  capabilityId: string,
) {
  await ctx.storage.db
    .delete(followedLights)
    .where(followed(deviceId, capabilityId));
  await ctx.entities.remove(targetKey(deviceId, capabilityId));
}

// Each light that follows the curve, read again once its turn comes, since a
// caller may have paused, resumed or stopped following it while the preceding
// light was being set. One that is gone from the home, or no longer a light,
// stops following. A check skips failures; startup must publish every target
// so an update's commit does not remove one whose publication failed.
async function eachFollowed(
  ctx: AppContext,
  runForLight: RunForLight,
  what: "follow" | "publish",
  work: (light: Light, row: Followed) => Promise<unknown>,
) {
  const rows = await ctx.storage.db.select().from(followedLights);
  for (const row of rows) {
    await runForLight(row.deviceId, row.capabilityId, async () => {
      const current = await followedRow(ctx, row.deviceId, row.capabilityId);
      if (!current) return;
      let light: Light;
      try {
        light = await lightOf(ctx, row.deviceId, row.capabilityId);
      } catch (error) {
        if (isActionError(error) && error.code === "not_found") {
          await forget(ctx, row.deviceId, row.capabilityId);
          return;
        }
        if (what === "publish") throw error;
        ctx.log(`could not read ${row.deviceId} (${describe(error)})`);
        return;
      }
      try {
        await work(light, current);
      } catch (error) {
        if (what === "publish") throw error;
        ctx.log(`could not ${what} ${light.device.name} (${describe(error)})`);
      }
    });
  }
}

// The sun for every light of one pass, read once the first light needs it, so
// a pass with no lights asks nothing.
function sunOnce(ctx: AppContext, options: FollowOptions) {
  let sun: Promise<HomeSun | null> | undefined;
  return () => (sun ??= homeSun(ctx, options.now()));
}

/** Brings every light that follows the curve to it. */
export async function followAll(
  ctx: AppContext,
  options: FollowOptions,
  runForLight: RunForLight,
) {
  const sun = sunOnce(ctx, options);
  await eachFollowed(ctx, runForLight, "follow", async (light, row) =>
    followOne(ctx, light, row, await sun(), options),
  );
}

/**
 * Publishes where every light that follows the curve stands, from its own
 * database and the lights as they are, setting none of them.
 */
export async function publishAll(
  ctx: AppContext,
  options: FollowOptions,
  runForLight: RunForLight,
) {
  const sun = sunOnce(ctx, options);
  await eachFollowed(ctx, runForLight, "publish", async (light, row) =>
    publish(ctx, light, standing(light, row, await sun(), options, ctx.appId)),
  );
}

function describe(error: unknown) {
  return isActionError(error)
    ? error.code
    : error instanceof Error
      ? error.message
      : String(error);
}
