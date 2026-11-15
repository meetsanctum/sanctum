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
} from "@meetsanctum/app-sdk";
import { entityId, type TelemetryEvent } from "esphome-client";

import {
  connectOnce,
  createConnection,
  defaultTimings,
  type Address,
  type Connection,
  type Session,
  type Timings,
} from "./connection.js";
import { mapEntities, signalOf, type Mapping } from "./entities.js";
import { createFacts, type Facts } from "./facts.js";
import { announcedOf, esphomeService, type Announced } from "./sightings.js";
import { lightCommandOf, stateOf } from "./states.js";

// ESPHome's side of the Drivers contract. It keeps no list of its devices:
// they are the core's record of what it added, read whole with the MAC
// address each was added by, and the keys they were flashed with are its
// secrets. Where each one is comes from what the home's network announces.

export type DriverOptions = { timings?: Partial<Timings> };

/** A device's key's name among the app's secrets. */
export const secretOf = (mac: string) => `key:${mac}`;

// A Noise key as ESPHome writes it: 32 bytes in base64.
const isKey = (text: string) => /^[A-Za-z0-9+/]{43}=$/.test(text);

const wrongKey = { refused: { question: "key", refusal: "wrongKey" } };

type Owned = {
  id: string;
  mac: string;
  connection: Connection;
  mapping: Mapping | null;
  // Its Wi-Fi signal's entity, by its key.
  signal: number | null;
  problem: string | null;
  sleeps: boolean;
  setup: Promise<void>;
};

/** What a session says the device is, for the core's record. */
function registrationOf(
  mac: string,
  session: Session,
  mapping: Mapping,
): DeviceRegistration {
  const { info } = session;
  const label = (text: string | undefined) =>
    text?.trim().slice(0, 120) || null;
  return {
    key: mac,
    name: label(info.friendlyName) ?? label(info.name) ?? mac,
    manufacturer: label(info.manufacturer),
    model: label(info.projectName) ?? label(info.model),
    capabilities: mapping.mapped.map((each) => each.capability),
    firmware: {
      version: label(info.esphomeVersion),
      updatable: false,
      sleeps: info.hasDeepSleep === true,
    },
  };
}

export function createDriver(ctx: AppContext, options: DriverOptions = {}) {
  const timings = { ...defaultTimings, ...options.timings };
  const facts: Facts = createFacts(ctx.storage.db);
  // What the network announces, by each sighting's name, and by MAC.
  const sightings = new Map<string, Announced>();
  const announced = new Map<string, Announced>();
  const devices = new Map<string, Owned>();
  let stopped = false;
  // Found devices go to the core one list at a time, in order.
  let listing = Promise.resolve();

  function addressOf(mac: string): Address | null {
    const found = announced.get(mac);
    const host = found?.addresses[0];
    return found && host ? { host, port: found.port } : null;
  }

  function listFound() {
    listing = listing
      .then(async () => {
        if (stopped) return;
        const found = [...announced.values()]
          .filter(
            (each) => !devices.has(each.mac) && each.encryption !== "waiting",
          )
          .slice(0, 64)
          .map((each) => ({
            key: each.mac,
            name: each.name.slice(0, 120),
            description:
              each.encryption === "key"
                ? "Needs its encryption key"
                : "Not encrypted",
            asks: each.encryption === "key" ? ["key"] : [],
          }));
        await ctx.devices.found(found);
      })
      .catch((error: unknown) => {
        ctx.log(`could not list found devices (${String(error)})`);
      });
    return listing;
  }

  function connected(owned: Owned, session: Session) {
    // A new socket must not take commands using the previous firmware's map.
    owned.mapping = null;
    const current = () =>
      devices.get(owned.mac) === owned && owned.connection.session === session;
    // An old session finishes its writes before a new one takes over, and
    // removal waits for those writes before the core forgets the device.
    const setup = owned.setup.then(async () => {
      if (!current()) return;
      const mapping = mapEntities(session.entities);
      const sleeps = session.info.hasDeepSleep === true;
      await ctx.devices.register(registrationOf(owned.mac, session, mapping));
      if (!current()) return;
      await facts.save(owned.mac, {
        address: `${session.address.host}:${session.address.port}`,
        encrypted: session.encrypted,
        version: session.info.esphomeVersion ?? null,
        unused: mapping.unused,
        sleeps,
      });
      if (!current()) return;
      if (owned.problem) {
        await ctx.devices.problem({ key: owned.mac, problem: null });
        if (!current()) return;
        owned.problem = null;
      }
      owned.mapping = mapping;
      owned.signal = signalOf(session.entities)?.key ?? null;
      owned.sleeps = sleeps;
    });
    owned.setup = setup.catch(() => undefined);
    return setup;
  }

  function state(owned: Owned, event: TelemetryEvent) {
    // A state event names its entity by its key, which a type keeps apart.
    if (event.type === "sensor" && event.key === owned.signal) {
      if (
        typeof event.state === "number" &&
        Number.isFinite(event.state) &&
        !event.missingState
      ) {
        facts
          .signal(owned.mac, Math.round(event.state))
          .catch((error: unknown) => {
            ctx.log(
              `could not save signal for ${owned.mac} (${String(error)})`,
            );
          });
      }
      return;
    }
    const mapped = owned.mapping?.mapped.find(
      (each) =>
        each.entity.type === event.type && each.entity.key === event.key,
    );
    if (!mapped) return;
    const capability = mapped.capability.id;
    const sent =
      event.type === "event"
        ? typeof event.eventType === "string" &&
          (
            mapped.capability.features as { actions: string[] }
          ).actions.includes(event.eventType)
          ? ctx.devices.press({
              key: owned.mac,
              capability,
              action: event.eventType,
            })
          : null
        : (() => {
            const now = stateOf(mapped, event);
            return now
              ? ctx.devices.report({
                  key: owned.mac,
                  states: { [capability]: now },
                })
              : null;
          })();
    sent?.catch((error: unknown) => {
      ctx.log(`could not report ${owned.mac} (${String(error)})`);
    });
  }

  // One of its devices from now on, connected with the session that added
  // it, or connecting itself.
  function own(device: DeviceInfo & { key: string }, session?: Session) {
    if (devices.has(device.key)) return devices.get(device.key)!;
    const mac = device.key;
    const owned: Owned = {
      id: device.id,
      mac,
      mapping: null,
      signal: null,
      problem: device.problem?.id ?? null,
      sleeps: device.firmware?.sleeps === true,
      setup: Promise.resolve(),
      connection: undefined as unknown as Connection,
    };
    owned.connection = createConnection({
      mac,
      key: () => ctx.secrets.get(secretOf(mac)),
      address: () => addressOf(mac),
      timings,
      events: {
        connected: (session) =>
          connected(owned, session).catch((error: unknown) => {
            ctx.log(`could not take in ${mac} (${String(error)})`);
            throw error;
          }),
        state: (event) => state(owned, event),
        reachable: (reachable) => {
          const availability = reachable
            ? "online"
            : owned.sleeps
              ? "unknown"
              : "offline";
          ctx.devices.report({ key: mac, availability }).catch(() => undefined);
        },
        halted: (halt) => {
          owned.problem = halt;
          ctx.devices
            .problem({ key: mac, problem: halt })
            .catch(() => undefined);
        },
      },
    });
    devices.set(mac, owned);
    if (session) owned.connection.adopt(session);
    else owned.connection.start();
    return owned;
  }

  function forget(mac: string) {
    const owned = devices.get(mac);
    if (!owned) return;
    devices.delete(mac);
    owned.connection.stop();
    return owned.setup;
  }

  // Connects once to check what someone typed, then lets the device's own
  // connection take over.
  async function check(mac: string, key: string | null) {
    const address = addressOf(mac);
    if (!address) throw new Error("It isn't on the home's network");
    return connectOnce({ mac, key, address, timings });
  }

  return {
    async start() {
      const removed = new Set<string>();
      let loading = true;
      // Following first, so no removal falls between following and reading.
      await ctx.events.on("device.removed", async ({ device }) => {
        const mac = device.key;
        if (device.driver !== ctx.appId || !mac) return;
        if (loading) removed.add(mac);
        await forget(mac);
        await ctx.secrets.delete(secretOf(mac));
        await facts.remove(mac);
        await listFound();
      });
      const mine = (await ctx.devices.list()).filter(
        (device): device is DeviceInfo & { key: string } =>
          device.driver === ctx.appId && typeof device.key === "string",
      );
      await ctx.devices.present({
        keys: mine
          .filter((device) => !removed.has(device.key))
          .map((device) => device.key),
      });
      for (const device of mine) {
        if (!removed.has(device.key)) own(device);
      }
      loading = false;
      await listFound();
    },

    async stop() {
      stopped = true;
      await Promise.all([...devices.keys()].map(forget));
    },

    async discovered({ found, lost }: DriverDiscovery) {
      for (const each of lost) {
        const was = sightings.get(each.name);
        sightings.delete(each.name);
        if (was && announced.get(was.mac) === was) announced.delete(was.mac);
      }
      for (const sighting of found) {
        if (sighting.service !== esphomeService) continue;
        const now = announcedOf(sighting);
        const was = sightings.get(sighting.name);
        if (was && was.mac !== now?.mac && announced.get(was.mac) === was) {
          announced.delete(was.mac);
        }
        if (!now) {
          sightings.delete(sighting.name);
          continue;
        }
        sightings.set(sighting.name, now);
        const before = announced.get(now.mac);
        announced.set(now.mac, now);
        // Announced anew where what it says of itself changed, as after
        // it's flashed again.
        const anew =
          !before ||
          before.addresses[0] !== now.addresses[0] ||
          before.port !== now.port ||
          before.encryption !== now.encryption ||
          before.version !== now.version;
        devices.get(now.mac)?.connection.seen(anew);
      }
      await listFound();
    },

    async add({ key, answers }: DriverAdd): Promise<DriverAddResult> {
      if (devices.has(key)) return;
      const found = announced.get(key);
      if (!found || found.encryption === "waiting") {
        throw new ActionError("not_found", "It isn't on the home's network");
      }
      const psk =
        found.encryption === "key" ? (answers.key ?? "").trim() : null;
      if (psk !== null && !isKey(psk)) return wrongKey;
      const result = await check(key, psk);
      if ("halt" in result) {
        if (psk !== null) return wrongKey;
        throw new Error("It has an encryption key now");
      }
      if ("error" in result) throw new Error("It didn't answer");
      const { session } = result;
      try {
        // Its key is kept before the core has the device, so no device of
        // Sanctum's is ever without the key it was added with.
        if (psk !== null) await ctx.secrets.set(secretOf(key), psk);
        else await ctx.secrets.delete(secretOf(key));
        const mapping = mapEntities(session.entities);
        const { id } = await ctx.devices.register(
          registrationOf(key, session, mapping),
        );
        // The session that checked it goes on as its connection.
        own({ ...(await ctx.devices.state(id)), key }, session);
      } catch (error) {
        session.client.disconnect();
        throw error;
      }
      await listFound();
    },

    async repair({ key, answers }: DriverRepair): Promise<DriverRepairResult> {
      const owned = devices.get(key);
      if (!owned) throw new ActionError("not_found", "No such device");
      const psk = (answers.key ?? "").trim();
      if (!isKey(psk)) return wrongKey;
      const result = await check(key, psk);
      if ("halt" in result) return wrongKey;
      if ("error" in result) throw new Error("It didn't answer");
      result.session.client.disconnect();
      await ctx.secrets.set(secretOf(key), psk);
      // Its connection clears the problem once it's back with the new key.
      owned.connection.renew();
    },

    // Its flashed key stays on the device. Stop registering it before the
    // core forgets it; its saved key and facts go with device.removed.
    async remove({ key }: DriverRemoval) {
      const owned = devices.get(key);
      if (!owned) return;
      owned.connection.stop();
      await owned.setup;
    },

    async command(command: DriverCommand) {
      const owned = devices.get(command.key);
      if (!owned)
        throw new ActionError("not_found", `No device ${command.key}`);
      // Which entity a part is comes from the device, once it's reached.
      const session = owned.connection.session;
      if (!session || !owned.mapping) throw new Error("It isn't reachable");
      const mapped = owned.mapping.mapped.find(
        (each) => each.capability.id === command.capability,
      );
      if (!mapped) {
        throw new ActionError(
          "not_found",
          `No ${command.capability} on ${command.key}`,
        );
      }
      const { entity } = mapped;
      if (command.kind === "light" && entity.type === "light") {
        session.client.command(
          entityId("light", entity.objectId),
          lightCommandOf(entity, command.command) as never,
        );
      } else if (command.kind === "switch" && entity.type === "switch") {
        session.client.command(entityId("switch", entity.objectId), {
          state: command.command.on,
        });
      } else {
        // A motion sensor's settings are its configuration's, not Sanctum's.
        throw new ActionError(
          "not_found",
          `${command.capability} takes no commands`,
        );
      }
    },

    /** What a device's page shows, by its id in the core. */
    async page(deviceId: string) {
      const owned = [...devices.values()].find((each) => each.id === deviceId);
      return owned ? facts.read(owned.mac) : null;
    },
  };
}

export type Driver = ReturnType<typeof createDriver>;
