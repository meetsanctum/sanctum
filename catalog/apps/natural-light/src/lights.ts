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
import { curveOf, isOnIn } from "./settings.js";
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
export type LightChange = { capability: LightCapability; at: Date };
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
 * What one call follows: its timing, the curve as the household set it, and
 * whether natural light is on. `isDueNow` has every light take it now, as
 * once the household changes it.
 */
export type FollowOptions = Timing & {
  curve: CurveSettings;
  isOn: boolean;
  isDueNow?: boolean;
};

/**
 * The options for one call, with the curve as its settings stand now.
 */
export async function followOptionsFor(
  ctx: AppContext,
  timing: Timing,
): Promise<FollowOptions> {
  const settings = await ctx.settings.get();
  return { ...timing, curve: curveOf(settings), isOn: isOnIn(settings) };
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

// Asks for a colour, which pauses the light altogether: a colour
// temperature or a hue, as a mood or a colour picked by hand does.
const asksColour = (asked: Partial<LightState>) =>
  asked.colorTemperature !== undefined || asked.hue !== undefined;

// Asks for a brightness alone, which leaves its colour to natural light:
// a remote's dimmer, a tile or a slider. Switching it on or off alone asks
// for neither.
const asksBrightnessAlone = (asked: Partial<LightState>) =>
  !asksColour(asked) && (asked.brightness ?? 0) > 0;

/**
 * Keeps each light's last colour or switch while changes wait to be read.
 * Brightness alone must not hide a preceding colour pause or its end.
 */
export function rememberLightChanges(
  changes: Map<string, LightChange>,
  device: DeviceInfo,
  now: Date,
) {
  for (const capability of device.capabilities) {
    if (capability.kind !== "light") continue;
    const asked = capability.setBy?.asked;
    if (
      capability.state?.on === false ||
      (asked && (asked.on !== undefined || asksColour(asked)))
    ) {
      const changedAt = Math.max(
        Date.parse(capability.changedAt ?? "") || 0,
        Date.parse(capability.setBy?.at ?? "") || 0,
      );
      changes.set(capability.id, {
        capability,
        at: changedAt ? new Date(changedAt) : now,
      });
    }
  }
}

// A look natural light set itself, such as a mood preview putting the light
// back as it was.
const isOwnLook = (asked: Partial<LightState>, applied: Look | null) =>
  applied !== null &&
  asked.hue === undefined &&
  (asked.colorTemperature === undefined ||
    asked.colorTemperature === applied.colorTemperature) &&
  (asked.brightness === undefined || asked.brightness === applied.brightness);

// Whether a pause or a dim from `at` has ended: the light was switched off,
// or switched on or off since.
function hasEnded(at: Date | null, capability: LightCapability) {
  return (
    at !== null &&
    (capability.state?.on === false ||
      (capability.setBy !== null &&
        Date.parse(capability.setBy.at) > at.getTime() &&
        capability.setBy.asked.on !== undefined))
  );
}

// Someone else's change since the light began following, or was last
// resumed, other than a look natural light set itself.
function othersChange(
  row: Pick<Followed, "since" | "applied">,
  capability: LightCapability,
  appId: string,
) {
  const { setBy } = capability;
  return setBy !== null &&
    setBy.app !== appId &&
    Date.parse(setBy.at) > row.since.getTime() &&
    (asksBrightnessAlone(setBy.asked) || !isOwnLook(setBy.asked, row.applied))
    ? setBy
    : null;
}

/** Whether a light that follows the curve is paused now, colour and all. */
export function isPaused(
  row: Pick<Followed, "since" | "pausedAt" | "applied">,
  capability: LightCapability,
  appId: string,
) {
  if (capability.state?.on !== true) {
    return false;
  }
  if (row.pausedAt && !hasEnded(row.pausedAt, capability)) {
    return true;
  }
  const change = othersChange(row, capability, appId);
  return change !== null && asksColour(change.asked);
}

/**
 * Since when a light that follows the curve has a brightness someone else
 * set, while natural light keeps its colour on the curve; null when it
 * hasn't. It is kept (`dimmedAt`) since natural light's own colour then
 * becomes what last set the light.
 */
export function dimmedSince(
  row: Pick<Followed, "since" | "dimmedAt" | "applied">,
  capability: LightCapability,
  appId: string,
): Date | null {
  if (capability.state?.on !== true) {
    return null;
  }
  if (row.dimmedAt && !hasEnded(row.dimmedAt, capability)) {
    return row.dimmedAt;
  }
  const change = othersChange(row, capability, appId);
  return change && asksBrightnessAlone(change.asked)
    ? new Date(change.at)
    : null;
}

/** Where a light that follows the curve and is on stands, pause-wise. */
export function pauseOf(
  row: Followed,
  capability: LightCapability,
  appId: string,
): "none" | "dimmed" | "paused" {
  if (isPaused(row, capability, appId)) return "paused";
  return dimmedSince(row, capability, appId) ? "dimmed" : "none";
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

// The core's answer to a command that holds only while a light is on, or
// off, once the light shows otherwise.
const isSwitchedMeanwhile = (error: unknown) =>
  isActionError(error) && error.code === "conflict";

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
  // A dimmed light's brightness is someone else's.
  brightness: status === "dimmed" ? null : (look?.brightness ?? null),
});

const statusOf = {
  none: "following",
  dimmed: "dimmed",
  paused: "paused",
} as const satisfies Record<ReturnType<typeof pauseOf>, TargetState["status"]>;

// Where a light that follows the curve stands while natural light is off.
const offTarget = (light: Light): TargetState => ({
  device: light.device.id,
  capability: light.capability.id,
  status: "off",
  colorTemperature: null,
  brightness: null,
});

/** Where one light that follows the curve stands now, without setting it. */
export function standing(
  light: Light,
  row: Followed,
  sun: HomeSun | null,
  options: FollowOptions,
  appId: string,
): TargetState {
  if (!options.isOn) {
    return offTarget(light);
  }
  const look = sun
    ? lookFor(options.curve, sun, light.capability, options.now())
    : null;
  return targetOf(light, look, statusOf[pauseOf(row, light.capability, appId)]);
}

/** Publishes where a light that follows the curve stands. */
export async function publish(
  ctx: AppContext,
  light: Light,
  state: TargetState,
) {
  await ctx.entities.publish({
    type: targetType.id,
    key: targetKey(light.device.id, light.capability.id),
    name: light.device.name,
    state,
  });
}

// A chosen colour stays paused even once a brightness command takes its
// place as who last set the light, and while the home has no curve.
async function keepPause(
  ctx: AppContext,
  light: Light,
  row: Followed,
  changedAt?: Date,
) {
  const { device, capability } = light;
  const kept = {
    pausedAt:
      (!changedAt || !row.pausedAt || row.pausedAt <= changedAt) &&
      hasEnded(row.pausedAt, capability)
        ? null
        : row.pausedAt,
    dimmedAt:
      (!changedAt || !row.dimmedAt || row.dimmedAt <= changedAt) &&
      hasEnded(row.dimmedAt, capability)
        ? null
        : row.dimmedAt,
  };
  if (!kept.pausedAt && isPaused({ ...row, ...kept }, capability, ctx.appId)) {
    kept.pausedAt = new Date(capability.setBy!.at);
  }
  if (kept.pausedAt !== row.pausedAt || kept.dimmedAt !== row.dimmedAt) {
    await ctx.storage.db
      .update(followedLights)
      .set(kept)
      .where(followed(device.id, capability.id));
    return { ...row, ...kept };
  }
  return row;
}

/**
 * Brings one light that follows the curve to it, or leaves it while it is
 * paused, or only its colour while it is dimmed, and publishes where it
 * stands. `force` sends the curve's look at once, as following or resuming
 * a light does.
 */
export async function followOne(
  ctx: AppContext,
  light: Light,
  row: Followed,
  sun: HomeSun | null,
  options: FollowOptions,
  force = false,
  isAgain = false,
): Promise<TargetState> {
  const { device, capability } = light;
  // A check may have waited for this light while the household changed
  // the settings. Use what stands now, once this light's turn has begun.
  options = await followOptionsFor(ctx, options);
  if (!options.isOn) {
    await publish(ctx, light, offTarget(light));
    return offTarget(light);
  }
  const now = options.now();
  const look = sun ? lookFor(options.curve, sun, capability, now) : null;
  const target = (status: TargetState["status"]) =>
    targetOf(light, look, status);
  row = await keepPause(ctx, light, row);
  if (!look) {
    await publish(ctx, light, target("waiting"));
    return target("waiting");
  }
  if (isPaused(row, capability, ctx.appId)) {
    await publish(ctx, light, target("paused"));
    return target("paused");
  }
  const dimmed = dimmedSince(row, capability, ctx.appId);
  if (dimmed && row.dimmedAt?.getTime() !== dimmed.getTime()) {
    // Kept, since natural light's own colour is about to be what last set
    // the light.
    await ctx.storage.db
      .update(followedLights)
      .set({ dimmedAt: dimmed })
      .where(followed(device.id, capability.id));
    row = { ...row, dimmedAt: dimmed };
  }
  // Dimmed, it takes the curve's colour and keeps its brightness.
  const sent: Look = dimmed
    ? { colorTemperature: look.colorTemperature }
    : look;
  const status = dimmed ? "dimmed" : "following";
  const command = commandFor(
    light,
    row,
    sent,
    { ...options, appId: ctx.appId, now },
    force,
  );
  if (command) {
    try {
      // What it is sent goes by whether it was read as on, so it holds only
      // while the light still shows that: the look a light that is off
      // comes back at never switches off one someone turned on meanwhile,
      // and a look for a light that is on never turns one back on.
      await ctx.devices.command({
        device: device.id,
        capability: capability.id,
        command,
        whileOn: capability.state?.on === true,
      });
      await ctx.storage.db
        .update(followedLights)
        .set({ applied: sent, appliedAt: now })
        .where(followed(device.id, capability.id));
    } catch (error) {
      // Switched meanwhile: once more, as the light stands now, with this
      // turn's row, which a requested resume has cleared of its pauses
      // before they are recorded.
      if (isSwitchedMeanwhile(error) && !isAgain) {
        return followOne(
          ctx,
          await lightOf(ctx, device.id, capability.id),
          row,
          sun,
          options,
          force,
          true,
        );
      }
      // Asked for now, the caller hears of it; otherwise the next check
      // tries again.
      if (force) {
        throw error;
      }
      ctx.log(`could not set ${device.name} (${describe(error)})`);
    }
  } else if (
    showsLook(capability.state, sent) &&
    (row.applied?.colorTemperature !== sent.colorTemperature ||
      row.applied?.brightness !== sent.brightness)
  ) {
    // Already at the curve: it counts as natural light's own look, so
    // putting it back after a mood preview pauses nothing.
    await ctx.storage.db
      .update(followedLights)
      .set({ applied: sent })
      .where(followed(device.id, capability.id));
  }
  await publish(ctx, light, target(status));
  return target(status);
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

/**
 * Lets go of a light that is off and holds natural light's look in the
 * core, so it comes back on as it remembers itself: an "off" with no look
 * drops what is held.
 */
export async function letGo(ctx: AppContext, light: Light) {
  const { device, capability } = light;
  if (
    capability.state?.on !== false ||
    capability.setBy?.app !== ctx.appId ||
    device.availability === "offline"
  ) {
    return;
  }
  try {
    await ctx.devices.command({
      device: device.id,
      capability: capability.id,
      command: { on: false },
      whileOn: false,
    });
  } catch (error) {
    // Turned on meanwhile, it holds nothing to let go of.
    if (!isSwitchedMeanwhile(error)) throw error;
  }
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
  what: "follow" | "publish" | "let go of",
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
 * Brings the lights of one device that follow the curve to it, as when the
 * device changed: a light someone let go of takes the curve at once, and
 * where each stands is published again.
 */
export async function followDevice(
  ctx: AppContext,
  deviceId: string,
  options: FollowOptions,
  runForLight: RunForLight,
  /**
   * When the device answered again after being offline, as a bulb behind a
   * wall switch does: that counts as switching it off and on, so any pause
   * or dim ends and it takes the curve at once.
   */
  cameBackAt?: Date,
  changes?: ReadonlyMap<string, LightChange>,
) {
  const rows = await ctx.storage.db
    .select()
    .from(followedLights)
    .where(eq(followedLights.deviceId, deviceId));
  const sun = sunOnce(ctx, options);
  for (const row of rows) {
    await runForLight(row.deviceId, row.capabilityId, async () => {
      let current = await followedRow(ctx, row.deviceId, row.capabilityId);
      if (!current) return;
      let light: Light;
      try {
        light = await lightOf(ctx, row.deviceId, row.capabilityId);
      } catch (error) {
        if (isActionError(error) && error.code === "not_found") {
          await forget(ctx, row.deviceId, row.capabilityId);
          return;
        }
        throw error;
      }
      if (cameBackAt) {
        const back = {
          since: current.since > cameBackAt ? current.since : cameBackAt,
          pausedAt:
            current.pausedAt && current.pausedAt > cameBackAt
              ? current.pausedAt
              : null,
          dimmedAt:
            current.dimmedAt && current.dimmedAt > cameBackAt
              ? current.dimmedAt
              : null,
        };
        await ctx.storage.db
          .update(followedLights)
          .set(back)
          .where(followed(row.deviceId, row.capabilityId));
        current = { ...current, ...back };
      }
      const remembered = changes?.get(row.capabilityId);
      if (remembered && current.since <= remembered.at) {
        current = await keepPause(
          ctx,
          { ...light, capability: remembered.capability },
          current,
          remembered.at,
        );
      }
      await followOne(ctx, light, current, await sun(), {
        ...options,
        isDueNow: cameBackAt ? true : options.isDueNow,
      });
    });
  }
}

/** Lets go of every light that follows the curve, as natural light is switched off. */
export async function letGoAll(ctx: AppContext, runForLight: RunForLight) {
  await eachFollowed(ctx, runForLight, "let go of", (light) =>
    letGo(ctx, light),
  );
}

/**
 * Has every light that follows the curve take it again from now, as
 * natural light is switched back on: what was set while it was off pauses
 * nothing.
 */
export async function followAgainFrom(ctx: AppContext, now: Date) {
  await ctx.storage.db
    .update(followedLights)
    .set({ since: now, pausedAt: null, dimmedAt: null });
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
