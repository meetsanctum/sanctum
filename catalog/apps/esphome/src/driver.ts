import {
  ActionError,
  type AppContext,
  type DeviceInfo,
  type DriverAdd,
  type DriverAddResult,
  type DriverCommand,
  type DriverDevice,
  type DriverDiscovery,
  type DriverRepair,
  type DriverRepairResult,
  type DriverRemoval,
} from "@meetsanctum/app-sdk";
import { entityId } from "esphome-client";

import {
  connectOnce,
  createConnection,
  defaultTimings,
  type Address,
  type Connection,
  type Session,
  type Timings,
} from "./connection.js";
import { mapEntities, type Mapping } from "./entities.js";
import { makerOf, registrationOf } from "./registration.js";
import { createFacts, type Facts } from "./facts.js";
import { createFound } from "./found.js";
import { createKeying } from "./keying.js";
import {
  giveKey,
  givenOf,
  newKey,
  secretOf,
  setupOf,
  takeKeyOff,
} from "./keys.js";
import { announcedOf, esphomeService, type Announced } from "./sightings.js";
import { report } from "./reports.js";
import { lightCommandOf } from "./states.js";

// ESPHome's side of the Drivers contract. It keeps no list of its devices:
// they are the core's record of what it added, read whole with the MAC
// address each was added by, and their keys, those they were flashed with
// and those it gave them (keys.ts), are its secrets. Where each one is comes
// from what the home's network announces.

export type DriverOptions = { timings?: Partial<Timings> };

// A Noise key as ESPHome writes it: 32 bytes in base64.
const isKey = (text: string) => /^[A-Za-z0-9+/]{43}=$/.test(text);

const wrongKey = { refused: { question: "key", refusal: "wrongKey" } };
const refused = (refusal: string) => ({ refused: { refusal } });

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
  // Its key being given anew by Repair, which ends its connections too.
  rekeying: boolean;
};

// How long a light flashes to show itself (Blink), at full brightness, before
// it goes back to what it was.
const flashMs = 1_500;

export function createDriver(ctx: AppContext, options: DriverOptions = {}) {
  const timings = { ...defaultTimings, ...options.timings };
  const facts: Facts = createFacts(ctx.storage.db);
  // What the network announces, by each sighting's name, and by MAC.
  const sightings = new Map<string, Announced>();
  const announced = new Map<string, Announced>();
  const devices = new Map<string, Owned>();
  let stopped = false;
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

  const finds = createFound({
    ctx,
    timings,
    announced,
    added: (mac) => devices.has(mac),
    givenKey,
    makerOf: (info) => makerOf(info).manufacturer,
  });

  const keying = createKeying({
    ctx,
    timings,
    finds,
    facts,
    addressOf,
    givenKey,
    check: (mac, key) => check(mac, key),
  });
  const { keepGiven, giveOlderKey } = keying;

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
      await facts.save(owned.mac, factsOf(session, mapping));
      if (!current()) return;
      // A device that could take a key and has none isn't encrypted, which
      // Repair sets right; any other problem is gone once it's back.
      const problem =
        !session.encrypted && session.info.apiEncryptionSupported === true
          ? "notEncrypted"
          : null;
      if (owned.problem !== problem) {
        // Said as it stands now, so no retry of the problem it had can
        // follow, even one that fails while the core is answering this.
        owned.problem = problem;
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

  // What a session tells of its device for the device's page.
  function factsOf(session: Session, mapping: Mapping) {
    return {
      address: `${session.address.host}:${session.address.port}`,
      encrypted: session.encrypted,
      version: session.info.esphomeVersion ?? null,
      unused: mapping.unused,
      sleeps: session.info.hasDeepSleep === true,
    };
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
      rekeying: false,
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
        state: (event, session) =>
          report(ctx, facts, mac, mappingOf(session), event, session),
        reachable: (reachable) => {
          const availability = reachable
            ? "online"
            : owned.sleeps
              ? "unknown"
              : "offline";
          ctx.devices.report({ key: mac, availability }).catch(() => undefined);
        },
        halted: (halt) => {
          // Its key coming off, or being given anew, ends its connection,
          // which is no problem.
          if (owned.removing || owned.rekeying) return;
          void keying.problemOf(mac, halt).then((problem) => {
            if (devices.get(mac) !== owned || owned.rekeying) return;
            owned.problem = problem;
            tell(owned);
          });
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

  // A key Sanctum gave a device that no longer takes it, forgotten, the
  // marker first, so a key it was flashed with is never taken for one.
  async function forgetGiven(mac: string) {
    await ctx.secrets.delete(givenOf(mac));
    await ctx.secrets.delete(secretOf(mac));
  }

  // Keeps the key a device was added with, or that it has none, before the
  // core has the device, so no device of Sanctum's is ever without the key
  // it was added with. The marker of a key Sanctum gave goes first, so a key
  // it was flashed with is never taken for one.
  async function keep(mac: string, psk: string | null, session: Session) {
    // A session in the clear, or under a typed key, can reach a device that
    // waits to be given a key: it's given one only once its card says so.
    if (session.info.apiEncryptionProvisionable === true) {
      session.client.disconnect();
      finds.learn(mac, "waits");
      await finds.list();
      return refused("changed");
    }
    try {
      await ctx.secrets.delete(givenOf(mac));
      if (psk !== null) await ctx.secrets.set(secretOf(mac), psk);
      else await ctx.secrets.delete(secretOf(mac));
    } catch (error) {
      session.client.disconnect();
      throw error;
    }
    return take(mac, session);
  }

  // A device from a session checked under its key, or under none: the
  // core's from now on, and its connection that session. Its page says how
  // its first key reached it where that's worth saying.
  async function take(
    mac: string,
    session: Session,
    firstKey: "setup" | null = null,
  ) {
    try {
      const mapping = mapEntities(session.entities);
      const { id } = await ctx.devices
        .register(registrationOf(mac, session, mapping))
        .catch((error: unknown) => {
          // Add says only that it failed, so the log says why.
          ctx.log(`could not register ${mac} (${String(error)})`);
          throw error;
        });
      if (firstKey) {
        await facts.save(mac, { ...factsOf(session, mapping), firstKey });
      }
      own({ ...(await ctx.devices.state(id)), key: mac }, session);
    } catch (error) {
      session.client.disconnect();
      throw error;
    }
    finds.learn(mac, session.encrypted ? "key" : "clear");
    await finds.list();
  }

  // Gives a device a key of its own again, as Add would, its connection
  // out of the way meanwhile, then back under the new key, which clears its
  // problem.
  async function rekey(owned: Owned) {
    owned.rekeying = true;
    try {
      await keying.keyAnew(owned.mac);
    } finally {
      owned.rekeying = false;
    }
    owned.connection.renew();
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
        await ctx.secrets.delete(setupOf(mac));
        await facts.remove(mac);
        await finds.list();
        finds.schedule();
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
      await finds.list();
      finds.schedule();
    },

    async stop() {
      stopped = true;
      await Promise.all([...[...devices.keys()].map(forget), finds.stop()]);
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
      finds.discoveryChanged();
      await finds.list();
      finds.schedule();
    },

    async add({ key, answers }: DriverAdd): Promise<DriverAddResult> {
      if (devices.has(key)) return;
      const listed = finds.said(key);
      if (!listed) {
        throw new ActionError("not_found", "It isn't on the home's network");
      }
      // A key Sanctum gave it, as before an answer was lost or as it was
      // removed while out of reach, is tried first, and only ever encrypted.
      const given = await givenKey(key);
      if (given) {
        const kept = await check(key, given);
        if ("session" in kept) return take(key, kept.session);
        if ("error" in kept) throw new Error("It didn't answer");
      }
      // Older firmware that took its setup key while the answer was lost
      // gets its own key over it, again only encrypted.
      const setup = await ctx.secrets.get(setupOf(key));
      if (setup) {
        const half = await check(key, setup);
        if ("error" in half) throw new Error("It didn't answer");
        if ("session" in half) {
          const session = await giveKey({
            mac: key,
            key: given ?? newKey(),
            session: half.session,
            address: () => addressOf(key),
            timings,
            keep: keepGiven(key),
          });
          await ctx.secrets.delete(setupOf(key));
          return take(key, session, "setup");
        }
      }
      // The key someone typed decides; where it doesn't match, what the
      // device says now does, as its record may be from before it was given
      // a key or had one taken off.
      if (answers.key !== undefined) {
        const psk = answers.key.trim();
        if (!isKey(psk)) return wrongKey;
        const result = await check(key, psk);
        if ("error" in result) throw new Error("It didn't answer");
        if ("halt" in result) {
          const now = await finds.ask(key);
          return now.says === "key" || now.says === "unclear"
            ? wrongKey
            : refused("changed");
        }
        return keep(key, psk, result.session);
      }
      const current = finds.said(key);
      if (
        (listed === "clear") !== (current === "clear") ||
        (listed === "older") !== (current === "older")
      ) {
        return refused("changed");
      }
      if (current === "older") {
        // Asked again first, every sign agreeing, as its card said.
        const now = await finds.ask(key);
        if (now.says === "unclear") throw new Error("It didn't answer");
        if (now.says !== "older") return refused("changed");
        const result = await giveOlderKey(key, given ?? newKey()).catch(
          (error: unknown) => {
            finds.retry(key);
            throw error;
          },
        );
        if ("session" in result) return take(key, result.session, "setup");
        if (result.has === "key") {
          if (given) await forgetGiven(key);
          finds.learn(key, "key");
        } else finds.retry(key);
        await finds.list();
        return refused(
          result.has === "changed"
            ? "changed"
            : given
              ? "keyChanged"
              : "hasKey",
        );
      }
      if (current === "clear") {
        // It booted without advertising encryption. Check it as listed;
        // some firmware can take a key without ever advertising provisioning.
        const result = await check(key, null);
        if ("halt" in result) {
          if (given) await forgetGiven(key);
          finds.learn(key, "key");
          await finds.list();
          return refused(given ? "keyChanged" : "hasKey");
        }
        if ("error" in result) throw new Error("It didn't answer");
        return keep(key, null, result.session);
      }
      // Asked first every time, so nothing happens that its card didn't say.
      const now = await finds.ask(key, { keepSession: true });
      if (now.says === "closed") return refused("notWaiting");
      if (now.says === "key") {
        // It no longer takes the key Sanctum gave it, as after it was
        // flashed again or keyed by another app: that key is forgotten.
        if (given) {
          await forgetGiven(key);
          await finds.list();
          return refused("keyChanged");
        }
        return refused("hasKey");
      }
      // Older firmware after all, as one reset since it was given a key:
      // its card now says so, and Add does what it says.
      if (now.says === "older") return refused("changed");
      // An answer in the clear, from a device whose record says it takes a
      // key, says only that it was busy or restarting, or that something
      // else answered: nothing is sent, and it's asked again.
      if (now.says !== "waits" || !now.session)
        throw new Error("It didn't answer");
      const session = await giveKey({
        mac: key,
        key: given ?? newKey(),
        session: now.session,
        address: () => addressOf(key),
        timings,
        // Kept before it's sent, so a device that took it while the
        // answer was lost isn't locked out.
        keep: keepGiven(key),
      }).catch((error: unknown) => {
        finds.retry(key);
        throw error;
      });
      return take(key, session);
    },

    async repair({
      key,
      problem,
      answers,
    }: DriverRepair): Promise<DriverRepairResult> {
      const owned = devices.get(key);
      if (!owned) throw new ActionError("not_found", "No such device");
      if (problem === "notEncrypted" || problem === "keyLost") {
        return rekey(owned);
      }
      const psk = (answers.key ?? "").trim();
      if (!isKey(psk)) return wrongKey;
      const result = await check(key, psk);
      if ("halt" in result) return wrongKey;
      if ("error" in result) throw new Error("It didn't answer");
      result.session.client.disconnect();
      // The key someone typed is the one it was flashed with, never taken
      // for one Sanctum gave: the marker goes first.
      await ctx.secrets.delete(givenOf(key));
      await ctx.secrets.set(secretOf(key), psk);
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
          const answer = await takeKeyOff({
            mac: key,
            key: given,
            session: owned.connection.session,
            address: () => addressOf(key),
            timings,
          });
          finds.learn(key, answer);
        } catch (error) {
          owned.removing = false;
          throw error;
        }
      } else if (given) {
        kept.add(key);
        finds.learn(key, "key");
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

    /** Has a device's first light flash, so a person sees which it is. */
    async identify({ key }: DriverDevice) {
      const owned = devices.get(key);
      if (!owned) throw new ActionError("not_found", `No device ${key}`);
      const session = owned.connection.session;
      if (!session || !owned.mapping) throw new Error("It isn't reachable");
      const light = owned.mapping.mapped.find(
        (each) => each.entity.type === "light",
      );
      if (!light) {
        throw new ActionError("conflict", `${key} has no light to flash`);
      }
      session.client.command(entityId("light", light.entity.objectId), {
        state: true,
        brightness: 1,
        flashLength: flashMs,
      } as never);
    },

    /** What a device's page shows, by its id in the core. */
    async page(deviceId: string) {
      const owned = [...devices.values()].find((each) => each.id === deviceId);
      return owned ? facts.read(owned.mac) : null;
    },
  };
}

export type Driver = ReturnType<typeof createDriver>;
