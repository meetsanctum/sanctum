import {
  ActionError,
  type AppContext,
  type DeviceInfo,
  type DeviceRegistration,
  type DriverAdd,
  type DriverAddResult,
  type DriverCommand,
  type DriverDiscovery,
  type DriverRepair,
  type DriverRepairResult,
  type DriverRemoval,
  type FoundReport,
} from "@meetsanctum/app-sdk";

import { createBoxes, type BoxVolume, type Boxes } from "./boxes.js";
import {
  createConnection,
  logText,
  type Connection,
  type Timings,
} from "./connection.js";
import { modelName } from "./models.js";
import {
  createPairings,
  type BoxKeys,
  type PairingOptions,
} from "./pairing.js";
import { createSightings, type Box } from "./sightings.js";

// The Apple Home Devices driver. It keeps no list of its boxes: they are the
// core's record of what it added, read with the key each was added by (the
// box's AirPlay device id), and each box's keys from pairing are a secret of
// its own. Where each box is comes from what the home's network announces.

export type DriverOptions = {
  boxes?: Boxes;
  timings?: Partial<Timings>;
  random?: () => number;
  pairing?: PairingOptions;
};

/** The secret that keeps one box's keys. */
export const secretOf = (key: string) => `box:${key}`;

/** The media capability's id on every box. */
export const mediaId = "media";

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

type Owned = {
  key: string;
  name: string;
  // Its model's name, as the core shows it: "Apple TV 4K".
  model: string;
  connection: Connection;
  // The last registered volume. A box can report steps when it passes them
  // on over HDMI, but a remote that sets volume by infrared can't report them.
  volume: "steps" | null;
  updates: Promise<void>;
};

export function createDriver(ctx: AppContext, options: DriverOptions = {}) {
  const boxes = options.boxes ?? createBoxes();
  const sightings = createSightings();
  const pairings = createPairings(boxes, options.pairing);
  const owned = new Map<string, Owned>();
  let stopped = false;

  function registration(box: {
    key: string;
    name: string;
    model: string;
    volume: "steps" | null;
  }): DeviceRegistration {
    return {
      key: box.key,
      name: box.name,
      manufacturer: "Apple",
      model: box.model,
      type: "media-player",
      capabilities: [
        {
          id: mediaId,
          kind: "media",
          features: {
            power: true,
            playback: [],
            volume: box.volume,
            mute: false,
          },
        },
      ],
    };
  }

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

  function own(device: Pick<Owned, "key" | "name" | "model" | "volume">) {
    const box: Owned = {
      ...device,
      updates: Promise.resolve(),
      connection: createConnection({
        key: device.key,
        boxes,
        timings: options.timings,
        random: options.random,
        news: {
          online(online) {
            void ctx.devices
              .report({
                key: device.key,
                availability: online ? "online" : "offline",
              })
              .catch(() => {});
          },
          state({ on, volume }) {
            box.updates = box.updates.then(() => said(box, on, volume));
          },
          lost() {
            void ctx.devices
              .problem({ key: device.key, problem: "pairingLost" })
              .catch(() => {});
          },
          log: (message) => ctx.log(message),
        },
      }),
    };
    owned.set(device.key, box);
    const seen = sightings.boxes().get(device.key);
    box.connection.seen(seen?.kind === "tv" ? seen : null);
    return box;
  }

  // Passes on what a box said, registering it again where its volume changed.
  // Asleep or with volume unknown, a box keeps the capability it last gave.
  async function said(box: Owned, on: boolean | null, volume: BoxVolume) {
    if (owned.get(box.key) !== box) return;
    const nextVolume = volume === "available" ? "steps" : null;
    if (on !== false && volume !== "unknown" && nextVolume !== box.volume) {
      try {
        await ctx.devices.register(
          registration({ ...box, volume: nextVolume }),
        );
        box.volume = nextVolume;
      } catch (error) {
        logFailure("Couldn't update volume for " + box.name, error);
      }
    }
    if (owned.get(box.key) !== box) return;
    try {
      await ctx.devices.report({
        key: box.key,
        states: {
          [mediaId]: { ...(on === null ? {} : { on }), activity: "idle" },
        },
      });
    } catch (error) {
      logFailure("Couldn't pass on " + box.name, error);
    }
  }

  async function forget(key: string) {
    const box = owned.get(key);
    owned.delete(key);
    box?.connection.stop();
    await box?.updates;
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
        box.connection.start(keys?.companion ?? null);
        if (!keys) {
          await ctx.devices.problem({
            key: device.key,
            problem: "pairingLost",
          });
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
          box.name = seen.name;
          box.model = modelName(seen.model);
          box.connection.seen(seen);
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
          await ctx.devices.register(registration(device));
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
        added.connection.start(keys.companion, pairedAt);
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
          box.connection.rekey(keys.companion, pairedAt);
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
      const what = command.command;
      if ("on" in what) return box.connection.power(what.on);
      if ("volumeStep" in what) return box.connection.volume(what.volumeStep);
      throw new ActionError("not_found", "It takes no such command");
    },
  };
}

export type Driver = ReturnType<typeof createDriver>;
