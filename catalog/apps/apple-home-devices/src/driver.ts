import {
  ActionError,
  type AppContext,
  type DeviceInfo,
  type DriverAdd,
  type DriverAddResult,
  type DriverCommand,
  type DriverDiscovery,
  type DriverRepair,
  type DriverRepairResult,
  type DriverRemoval,
  type FoundReport,
} from "@meetsanctum/app-sdk";

import { createBoxes, type Boxes } from "./boxes.js";
import { logText } from "./connection.js";
import { modelName } from "./models.js";
import {
  createPairings,
  type BoxKeys,
  type PairingOptions,
} from "./pairing.js";
import { createSightings, type Box } from "./sightings.js";
import {
  createTv,
  isCurrent,
  mediaId,
  registrationOf,
  type Tv,
  type TvTimings,
  type Volume,
} from "./tv.js";

// The Apple Home Devices driver. It keeps no list of its boxes: they are the
// core's record of what it added, read with the key each was added by (the
// box's AirPlay device id), and each box's keys from pairing are a secret of
// its own. Where each box is comes from what the home's network announces.

export type DriverOptions = {
  boxes?: Boxes;
  timings?: Partial<TvTimings>;
  random?: () => number;
  now?: () => number;
  pairing?: PairingOptions;
};

/** The secret that keeps one box's keys. */
export const secretOf = (key: string) => `box:${key}`;

const isKeys = (value: unknown): value is BoxKeys => {
  const keys = (value ?? {}) as Partial<BoxKeys>;
  const fine = (part: unknown) =>
    typeof part === "object" &&
    part !== null &&
    ["clientId", "clientLTSK", "clientLTPK", "serverLTPK", "serverId"].every(
      (field) => typeof (part as Record<string, unknown>)[field] === "string",
    );
  return fine(keys.airplay) && fine(keys.companion);
};

export function createDriver(ctx: AppContext, options: DriverOptions = {}) {
  const boxes = options.boxes ?? createBoxes();
  const sightings = createSightings();
  const pairings = createPairings(boxes, options.pairing);
  const owned = new Map<string, Tv>();
  let stopped = false;

  async function keysOf(key: string): Promise<BoxKeys | null> {
    const kept = await ctx.secrets.get(secretOf(key));
    if (!kept) return null;
    try {
      const keys: unknown = JSON.parse(kept);
      return isKeys(keys) ? keys : null;
    } catch {
      return null;
    }
  }

  function logFailure(message: string, error: unknown) {
    ctx.log(
      logText(message) +
        ": " +
        logText(error instanceof Error ? error.message : String(error)),
    );
  }

  function own(device: {
    key: string;
    name: string;
    model: string;
    volume: Volume;
  }) {
    const tv = createTv({
      ctx,
      ...device,
      boxes,
      timings: options.timings,
      random: options.random,
      now: options.now,
    });
    owned.set(device.key, tv);
    const seen = sightings.boxes().get(device.key);
    tv.seen(seen?.kind === "tv" ? seen : null);
    return tv;
  }

  async function forget(key: string) {
    const tv = owned.get(key);
    owned.delete(key);
    await tv?.stop();
  }

  // Every box Add devices lists: those seen that the home hasn't added.
  async function listFound() {
    if (stopped) return;
    const found: FoundReport[] = [];
    for (const [key, box] of sightings.boxes()) {
      if (owned.has(key)) continue;
      found.push({
        key,
        name: box.name,
        description: modelName(box.model),
        type: "media-player",
      });
    }
    await ctx.devices.found(found.slice(0, 64)).catch((error: unknown) => {
      ctx.log(`Couldn't list the boxes found: ${String(error)}`);
    });
  }

  function boxOf(key: string): Box {
    const box = sightings.boxes().get(key);
    if (!box)
      throw new ActionError("not_found", "It isn't on the home's network");
    return box;
  }

  return {
    async start() {
      const removed = new Set<string>();
      let loading = true;
      // Following first, so no removal falls between following and reading.
      await ctx.events.on("device.removed", async ({ device }) => {
        if (device.driver !== ctx.appId || !device.key) return;
        if (loading) removed.add(device.key);
        await forget(device.key);
        await ctx.secrets.delete(secretOf(device.key));
        await listFound();
      });
      const mine = (await ctx.devices.list()).filter(
        (device): device is DeviceInfo & { key: string } =>
          device.driver === ctx.appId && typeof device.key === "string",
      );
      const kept = mine.filter((device) => !removed.has(device.key));
      await ctx.devices.present({ keys: kept.map((device) => device.key) });
      for (const device of kept) {
        const keys = await keysOf(device.key);
        const media = device.capabilities.find(
          (capability) =>
            capability.kind === "media" && capability.id === mediaId,
        );
        const box = own({
          key: device.key,
          name: device.driverName ?? device.name,
          model: device.model ?? "Apple TV",
          volume:
            media?.kind === "media" && media.features.volume === "steps"
              ? "steps"
              : null,
        });
        // A TV added before playback was taken gets it now.
        if (media?.kind !== "media" || !isCurrent(media.features)) {
          box.outdated();
        }
        box.start(keys);
        if (!keys) {
          try {
            await ctx.devices.problem({
              key: device.key,
              problem: "pairingLost",
            });
          } catch (error) {
            logFailure("Couldn't report lost pairing for " + box.name, error);
          }
        }
      }
      loading = false;
      await listFound();
    },

    async stop() {
      stopped = true;
      pairings.closeAll();
      for (const key of [...owned.keys()]) await forget(key);
    },

    async discovered(discovery: DriverDiscovery) {
      const changed = sightings.take(discovery);
      const now = sightings.boxes();
      for (const key of changed) {
        const box = owned.get(key);
        const seen = now.get(key);
        if (!box) continue;
        if (seen?.kind === "tv") {
          box.seen(seen, seen.name, modelName(seen.model));
        }
      }
      await listFound();
    },

    async add(add: DriverAdd): Promise<DriverAddResult> {
      if (owned.has(add.key)) return;
      const box = boxOf(add.key);
      if (box.kind === "homepod") return { refused: { refusal: "homePod" } };
      return pairings.step(add.key, box, add, async (keys, pairedAt) => {
        const secret = secretOf(add.key);
        const device = {
          key: add.key,
          name: box.name,
          model: modelName(box.model),
          volume: null,
        };
        await ctx.secrets.set(secret, JSON.stringify(keys));
        try {
          await ctx.devices.register(registrationOf(device));
        } catch (error) {
          // If the answer was lost, keep the keys for a device the core added.
          const devices = await ctx.devices.list().catch(() => null);
          if (
            !devices?.some(
              (each) => each.driver === ctx.appId && each.key === add.key,
            )
          ) {
            if (devices) {
              await ctx.secrets.delete(secret).catch((failure: unknown) => {
                logFailure("Couldn't remove unused pairing keys", failure);
              });
            }
            throw error;
          }
        }
        const added = own(device);
        added.start(keys, pairedAt);
        await listFound();
      });
    },

    async cancelAdd({ key, attempt }: { key: string; attempt: string }) {
      pairings.cancel(key, attempt);
    },

    async repair(repair: DriverRepair): Promise<DriverRepairResult> {
      const box = owned.get(repair.key);
      if (!box) throw new ActionError("not_found", `No device ${repair.key}`);
      const seen = boxOf(repair.key);
      if (seen.kind !== "tv") {
        throw new ActionError(
          "not_found",
          "The TV isn't on the home's network",
        );
      }
      const answer = await pairings.step(
        repair.key,
        seen,
        repair,
        async (keys, pairedAt) => {
          await ctx.secrets.set(secretOf(repair.key), JSON.stringify(keys));
          box.rekey(keys, pairedAt);
          await ctx.devices.problem({ key: repair.key, problem: null });
        },
      );
      // Repairing asks nothing that ends it with a refusal of adding.
      if (answer && "refused" in answer && !("asks" in answer)) {
        const { question, refusal } = answer.refused;
        if (question === undefined) {
          throw new Error(
            refusal === "notAllowed"
              ? `${box.name} didn't let Sanctum pair`
              : `${box.name} couldn't be reached`,
          );
        }
        return { refused: { question, refusal } };
      }
      return answer;
    },

    async cancelRepair({ key, attempt }: { key: string; attempt: string }) {
      pairings.cancel(key, attempt);
    },

    // Sanctum can't take its pairing off the box, so removing one drops
    // its connection and keys here; the box lists the pairing until it's
    // removed in tvOS.
    async remove({ key }: DriverRemoval) {
      await forget(key);
      await ctx.secrets.delete(secretOf(key));
      await listFound();
    },

    async command(command: DriverCommand) {
      const box = owned.get(command.key);
      if (!box) throw new ActionError("not_found", `No device ${command.key}`);
      if (command.kind !== "media" || command.capability !== mediaId) {
        throw new ActionError("not_found", `No ${command.capability} on it`);
      }
      await box.command(command.command);
    },
  };
}

export type Driver = ReturnType<typeof createDriver>;
