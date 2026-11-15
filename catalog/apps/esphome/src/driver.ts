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
import {
  giveKey,
  givenOf,
  newKey,
  partsOf,
  takeKeyOff,
  zeroKey,
} from "./keys.js";
import { announcedOf, esphomeService, type Announced } from "./sightings.js";
import { lightCommandOf, stateOf } from "./states.js";

// ESPHome's side of the Drivers contract. It keeps no list of its devices:
// they are the core's record of what it added, read whole with the MAC
// address each was added by, and their keys, those they were flashed with
// and those it gave them (keys.ts), are its secrets. Where each one is comes
// from what the home's network announces.

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
  problem: string | null;
  sleeps: boolean;
  setup: Promise<void>;
  // What the core last took of its problem, unknown once an answer is
  // lost, and the report that's latest.
  told: string | null | undefined;
  reports: number;
  // Saying its problem again, after the core didn't take it.
  telling?: ReturnType<typeof setTimeout>;
  // Its key coming off as it's removed, which ends its connection.
  removing: boolean;
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
  // What each device waiting for a key has, by MAC, for the version it
  // runs, as a connection under the zero key told it.
  const described = new Map<
    string,
    { version: string | null; parts: string | null }
  >();
  // Devices removed with the key Sanctum gave them still on them, as when
  // they couldn't be reached, whose keys it keeps.
  const kept = new Set<string>();

  // The key Sanctum gave a device, if it gave one.
  async function givenKey(mac: string) {
    if (!(await ctx.secrets.get(givenOf(mac)))) return null;
    return ctx.secrets.get(secretOf(mac));
  }

  function addressOf(mac: string): Address | null {
    const found = announced.get(mac);
    const host = found?.addresses[0];
    return found && host ? { host, port: found.port } : null;
  }

  function listFound() {
    listing = listing
      .then(async () => {
        if (stopped) return;
        const listed = [...announced.values()]
          .filter((each) => !devices.has(each.mac))
          .slice(0, 64);
        const found = [];
        for (const each of listed) {
          const row = { key: each.mac, name: each.name.slice(0, 120) };
          if (each.encryption === "waiting") {
            const parts = described.get(each.mac)?.parts;
            found.push({
              ...row,
              description: parts ?? "Gets an encryption key of its own",
              asks: [],
            });
          } else if (each.encryption === "none") {
            found.push({ ...row, description: "Not encrypted", asks: [] });
          } else if (await givenKey(each.mac)) {
            // Removed with the key it was given still on it, it's added
            // with that key again.
            found.push({
              ...row,
              description: "Has the key it was given before",
              asks: [],
            });
          } else {
            found.push({
              ...row,
              description: "Needs its encryption key",
              asks: ["key"],
            });
          }
        }
        await ctx.devices.found(found);
      })
      .catch((error: unknown) => {
        ctx.log(`could not list found devices (${String(error)})`);
      });
    return listing;
  }

  function connected(owned: Owned, session: Session, hear: () => void) {
    // A new socket must not take commands using the previous firmware's map.
    owned.mapping = null;
    // Its latest session, open or closed since with nothing in its place.
    const current = () =>
      devices.get(owned.mac) === owned &&
      (owned.connection.session ?? session) === session;
    // An old session finishes its writes before a new one takes over, and
    // removal waits for those writes before the core forgets the device.
    const work = async () => {
      if (!current()) return;
      const mapping = mappingOf(session);
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
        // Cleared before it's said, so no retry of the problem it had can
        // follow, even one that fails while the core is answering this.
        owned.problem = null;
        tell(owned);
      }
      owned.mapping = mapping;
      owned.sleeps = sleeps;
    };
    const setup = owned.setup.then(async () => {
      await work();
      // Heard as the last of its setup, so what it held reaches the core
      // before a later session's setup registers what that one has.
      if (devices.get(owned.mac) === owned) hear();
    });
    owned.setup = setup.catch(() => undefined);
    return setup;
  }

  // Each session's parts, by its own entities, so what an older session
  // said is read by the parts it had.
  const mappings = new WeakMap<Session, Mapping>();
  function mappingOf(session: Session) {
    let mapping = mappings.get(session);
    if (!mapping) {
      mapping = mapEntities(session.entities);
      mappings.set(session, mapping);
    }
    return mapping;
  }

  function state(owned: Owned, event: TelemetryEvent, session: Session) {
    // A state event names its entity by its key, which a type keeps apart.
    if (
      event.type === "sensor" &&
      event.key === signalOf(session.entities)?.key
    ) {
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
    const mapped = mappingOf(session).mapped.find(
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
      problem: device.problem?.id ?? null,
      told: device.problem?.id ?? null,
      reports: 0,
      sleeps: device.firmware?.sleeps === true,
      setup: Promise.resolve(),
      removing: false,
      connection: undefined as unknown as Connection,
    };
    owned.connection = createConnection({
      mac,
      key: () => ctx.secrets.get(secretOf(mac)),
      address: () => addressOf(mac),
      timings,
      events: {
        connected: (session, hear) =>
          connected(owned, session, hear).catch((error: unknown) => {
            ctx.log(`could not take in ${mac} (${String(error)})`);
            throw error;
          }),
        state: (event, session) => state(owned, event, session),
        reachable: (reachable) => {
          const availability = reachable
            ? "online"
            : owned.sleeps
              ? "unknown"
              : "offline";
          ctx.devices.report({ key: mac, availability }).catch(() => undefined);
        },
        halted: (halt) => {
          // Its key coming off ends its connection, which is no problem.
          if (owned.removing) return;
          owned.problem = halt;
          tell(owned);
        },
      },
    });
    devices.set(mac, owned);
    if (session) owned.connection.adopt(session);
    else owned.connection.start();
    return owned;
  }

  // Says a device's problem, as it stands when it's said, until the core
  // takes it: so it never waits for Repair with nothing saying so, and a
  // retry never says a problem it no longer has.
  function tell(owned: Owned, attempt = 0) {
    clearTimeout(owned.telling);
    const problem = owned.problem;
    const report = ++owned.reports;
    ctx.devices.problem({ key: owned.mac, problem }).then(
      () => {
        if (report === owned.reports) owned.told = problem;
      },
      () => {
        // Its answer lost, whether the core has it is unknown, so the next
        // report is said whatever it is.
        if (report === owned.reports) owned.told = undefined;
        if (stopped || devices.get(owned.mac) !== owned) return;
        owned.telling = setTimeout(
          () => {
            // A later report may have said it since.
            if (owned.problem !== owned.told) tell(owned, attempt + 1);
          },
          Math.min(timings.firstPauseMs * 2 ** attempt, timings.longestPauseMs),
        );
      },
    );
  }

  function forget(mac: string) {
    const owned = devices.get(mac);
    if (!owned) return;
    clearTimeout(owned.telling);
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

  // What a device waiting for a key has, once for each version it runs,
  // over a connection under the zero key.
  async function describe(found: Announced) {
    const before = described.get(found.mac);
    if (before && before.version === found.version) return;
    described.set(found.mac, { version: found.version, parts: null });
    const address = addressOf(found.mac);
    if (!address) return;
    const result = await connectOnce({
      mac: found.mac,
      key: zeroKey,
      address,
      timings,
    });
    if (!("session" in result)) return;
    result.session.client.disconnect();
    described.set(found.mac, {
      version: found.version,
      parts: partsOf(mapEntities(result.session.entities)),
    });
    await listFound();
  }

  // A device from a session checked under its key, or under none: the
  // core's from now on, and its connection that session.
  async function take(mac: string, session: Session) {
    try {
      const mapping = mapEntities(session.entities);
      const { id } = await ctx.devices.register(
        registrationOf(mac, session, mapping),
      );
      own({ ...(await ctx.devices.state(id)), key: mac }, session);
    } catch (error) {
      session.client.disconnect();
      throw error;
    }
    await listFound();
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
        // A key it was given stays on it when it couldn't be reached, and
        // is kept, so finding it again adds it as it was.
        if (!kept.delete(mac)) {
          await ctx.secrets.delete(secretOf(mac));
          await ctx.secrets.delete(givenOf(mac));
        }
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
        if (now.encryption === "waiting" && !devices.has(now.mac)) {
          void describe(now).catch(() => undefined);
        }
      }
      await listFound();
    },

    async add({ key, answers }: DriverAdd): Promise<DriverAddResult> {
      if (devices.has(key)) return;
      const found = announced.get(key);
      if (!found) {
        throw new ActionError("not_found", "It isn't on the home's network");
      }
      // A key Sanctum gave it, as before an answer was lost or as it was
      // removed while out of reach, is tried first.
      const given = await givenKey(key);
      if (given) {
        const kept = await check(key, given);
        if ("session" in kept) return take(key, kept.session);
      }
      if (found.encryption === "waiting") {
        const gave = await giveKey({
          mac: key,
          key: given ?? newKey(),
          address: () => addressOf(key),
          timings,
          // Kept before it's sent, so a device that took it while the
          // answer was lost isn't locked out.
          keep: async (psk) => {
            await ctx.secrets.set(secretOf(key), psk);
            await ctx.secrets.set(givenOf(key), "yes");
          },
        });
        if ("notWaiting" in gave) return { refused: { refusal: "notWaiting" } };
        return take(key, gave.session);
      }
      if (given) throw new Error("It has another key now");
      const psk =
        found.encryption === "key" ? (answers.key ?? "").trim() : null;
      if (psk !== null && !isKey(psk)) return wrongKey;
      const result = await check(key, psk);
      if ("halt" in result) {
        if (psk !== null) return wrongKey;
        throw new Error("It has an encryption key now");
      }
      if ("error" in result) throw new Error("It didn't answer");
      // Its key is kept before the core has the device, so no device of
      // Sanctum's is ever without the key it was added with.
      if (psk !== null) await ctx.secrets.set(secretOf(key), psk);
      else await ctx.secrets.delete(secretOf(key));
      await ctx.secrets.delete(givenOf(key));
      return take(key, result.session);
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
      // The key someone typed is the one it was flashed with.
      await ctx.secrets.set(secretOf(key), psk);
      await ctx.secrets.delete(givenOf(key));
      // Its connection clears the problem once it's back with the new key.
      owned.connection.renew();
    },

    // A key Sanctum gave the device comes off it, so it waits for a key
    // again, or stays on it with Remove anyway, kept here; a key it was
    // flashed with stays. Its connection stops before the core forgets it,
    // and its saved key and facts go with device.removed.
    async remove({ key, force }: DriverRemoval) {
      const owned = devices.get(key);
      if (!owned) return;
      const given = await givenKey(key);
      if (given && !force) {
        owned.removing = true;
        try {
          await takeKeyOff({
            mac: key,
            key: given,
            session: owned.connection.session,
            address: () => addressOf(key),
            timings,
          });
        } catch (error) {
          owned.removing = false;
          throw error;
        }
      } else if (given) {
        kept.add(key);
      }
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
