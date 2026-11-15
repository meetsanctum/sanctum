import {
  ActionError,
  capabilityOf,
  createAppContext,
  deviceFirmware,
  deviceJoining,
  devicePresence,
  devicePress,
  deviceRegistration,
  deviceRelease,
  deviceProblemReport,
  deviceReport,
  answersTo,
  foundDevices,
  isDeclaredRefusal,
  permissionIds,
  shownProblem,
  shownQuestions,
  type Actor,
  type AppContext,
  type AppDefinition,
  type Availability,
  type CapabilityKind,
  type CoreCalls,
  type CoreEvent,
  type CoreEventHandlers,
  type DeviceInfo,
  type DeviceType,
  type DriverCommand,
  type DeviceProblem,
  type DriverDiscovery,
  type DriverDevice,
  type FoundDevice,
  type DriverRemoval,
  type LightMove,
  type JoiningStage,
  type ServiceConnection,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import { createSecretCalls } from "./secret-calls.js";
import { createTestStorage } from "./storage.js";

// A fake core for one driver app: it takes the driver's registrations,
// reports, presses and releases, what it says of joining devices and of
// firmware, and which devices it still has exactly as the core does, with
// the same schemas, remembers them, and hands the driver commands, moves,
// pairing, removals, firmware calls, probes, repairs and adding the devices
// it found, and keeps its secrets, what it says is wrong with its devices and
// which devices it could add. It lists the driver's own devices whole, with
// their keys, as the core does for a driver, hands it the events it follows,
// such as a device's removal, and keeps its own database when given its
// migrations. Nothing else of the core is there.

type Registered = z.output<typeof deviceRegistration>;

export type Joining = {
  key: string;
  stage: JoiningStage;
  description: string | null;
};

export type Reported = {
  key: string;
  availability?: string;
  states: Record<string, Record<string, unknown>>;
  battery?: number;
};

export type Pressed = { key: string; capability: string; action: string };

export type Released = { key: string; capability: string };

export type FirmwareSaid = z.output<typeof deviceFirmware>;

async function absent(): Promise<never> {
  throw new Error("The driver suite's core has no such call");
}

export function createDriverCore(
  app: AppDefinition,
  options: {
    services?: Record<string, ServiceConnection>;
    // Calls the core doesn't answer, failing as when it can't be reached.
    unanswered?: (keyof CoreCalls)[];
    // The app's migrations, for its own database.
    migrationsFolder?: string;
  } = {},
) {
  const registered = new Map<string, Registered>();
  const reports: Reported[] = [];
  const presses: Pressed[] = [];
  const releases: Released[] = [];
  // Each device's availability as the core holds it, from the driver's
  // reports and from which devices it said it still has.
  const availability = new Map<string, Availability>();
  // The devices being removed, which the driver may no longer have before
  // the core forgets them.
  const removing = new Set<string>();
  const joining: Joining[] = [];
  const firmware: FirmwareSaid[] = [];
  // What the core refused, which a driver must never send.
  const refused: Error[] = [];
  // Each list of the devices the driver said are here.
  const presented: string[][] = [];
  const { secrets, calls: secretCalls } = createSecretCalls(app.id, refuse);
  // What the driver says is wrong with each of its devices, as the core
  // shows it.
  const problems = new Map<string, DeviceProblem>();
  // The devices it last said it could add, as Add devices shows them, those
  // it has left out.
  let found: FoundDevice[] = [];
  const storage = options.migrationsFolder
    ? createTestStorage({ migrationsFolder: options.migrationsFolder })
    : null;
  // The events the driver follows, and its handlers for them.
  const followed = new Set<string>();
  const handlers: CoreEventHandlers = new Map();

  // One of its devices as the driver reads it: whole, with its key.
  function infoOf(device: Registered): DeviceInfo {
    return {
      id: `device:${device.key}`,
      name: device.name,
      driver: app.id,
      manufacturer: device.manufacturer,
      model: device.model,
      roomId: null,
      driverName: device.name,
      type: (device.type ?? "unknown") as DeviceType,
      availability: availability.get(device.key) ?? "unknown",
      lastSeenAt: null,
      capabilities: device.capabilities.map((each) => {
        const state = latestOf(device.key, each.id) ?? null;
        return {
          ...each,
          state,
          observed: state,
          desired: null,
          sync: "synced",
          setBy: null,
          changedAt: null,
        };
      }) as DeviceInfo["capabilities"],
      firmware: device.firmware && {
        ...device.firmware,
        state: null,
        progress: null,
        remainingSeconds: null,
        problem: null,
        checkedAt: null,
      },
      probe: device.probe,
      battery: null,
      leftAt: null,
      problem: problems.get(device.key) ?? null,
      key: device.key,
    } as DeviceInfo;
  }

  function latestOf(key: string, capability: string) {
    for (const report of [...reports].reverse()) {
      if (report.key === key && report.states[capability]) {
        return report.states[capability];
      }
    }
    return undefined;
  }

  // Hands the driver one of the core's events, if it follows it.
  async function deliver(event: CoreEvent) {
    if (!followed.has(event.name)) return;
    for (const handler of handlers.get(event.name) ?? []) {
      await handler(event);
    }
  }

  function refuse(error: Error): never {
    refused.push(error);
    throw error;
  }

  const core: CoreCalls = {
    query: storage ? (query) => storage.query(query) : absent,
    settings: absent,
    // Every permission it asks for: this core grants them all.
    permissions: async () => permissionIds(app.permissions),
    permissionsRevision: async () => 0,
    people: absent,
    places: absent,
    location: absent,
    publish: absent,
    unpublish: absent,
    entities: absent,
    fetch: absent,
    devices: async () => [...registered.values()].map(infoOf),
    async device(id) {
      const device = [...registered.values()].find(
        (each) => `device:${each.key}` === id,
      );
      if (!device) refuse(new ActionError("not_found", `No device ${id}`));
      return infoOf(device);
    },
    command: absent,
    async serviceConnection(name) {
      const connection = options.services?.[name];
      if (!connection) {
        throw new Error(`No service ${name} in this suite`);
      }
      return connection;
    },
    async register(input) {
      const parsed = deviceRegistration.safeParse(input);
      if (!parsed.success) {
        refuse(
          new Error(`Registration refused: ${z.prettifyError(parsed.error)}`),
        );
      }
      if (!registered.has(parsed.data.key)) {
        availability.set(parsed.data.key, "unknown");
      }
      registered.set(parsed.data.key, parsed.data);
      return { id: `device:${parsed.data.key}` };
    },
    async report(input) {
      const parsed = deviceReport.safeParse(input);
      if (!parsed.success) {
        refuse(new Error(`Report refused: ${z.prettifyError(parsed.error)}`));
      }
      const { key, availability: said, states = {}, battery } = parsed.data;
      const device = registered.get(key);
      if (!device) {
        refuse(new ActionError("not_found", `No device ${key}`));
      }
      const checked: Reported["states"] = {};
      for (const [id, state] of Object.entries(states)) {
        const capability = device.capabilities.find((each) => each.id === id);
        if (!capability) {
          refuse(
            new ActionError("not_found", `${key} has no capability ${id}`),
          );
        }
        const observed = capabilityOf(capability.kind).state.safeParse(state);
        if (!observed.success) {
          refuse(
            new Error(
              `${capability.kind} state refused: ${z.prettifyError(observed.error)}`,
            ),
          );
        }
        checked[id] = observed.data as Record<string, unknown>;
      }
      reports.push({
        key,
        ...(said ? { availability: said } : {}),
        states: checked,
        ...(battery === undefined ? {} : { battery }),
      });
      if (said) availability.set(key, said);
    },
    async press(input) {
      const parsed = devicePress.safeParse(input);
      if (!parsed.success) {
        refuse(new Error(`Press refused: ${z.prettifyError(parsed.error)}`));
      }
      const { key, capability: id, action } = parsed.data;
      const capability = registered
        .get(key)
        ?.capabilities.find((each) => each.id === id);
      if (capability?.kind !== "button") {
        refuse(new ActionError("not_found", `${key} has no button ${id}`));
      }
      if (!capability.features.actions.includes(action)) {
        refuse(new Error(`${key}'s ${id} does not declare ${action}`));
      }
      presses.push(parsed.data);
      availability.set(key, "online");
    },
    async release(input) {
      const parsed = deviceRelease.safeParse(input);
      if (!parsed.success) {
        refuse(new Error(`Release refused: ${z.prettifyError(parsed.error)}`));
      }
      const { key, capability: id } = parsed.data;
      const capability = registered
        .get(key)
        ?.capabilities.find((each) => each.id === id);
      if (capability?.kind !== "button") {
        refuse(new ActionError("not_found", `${key} has no button ${id}`));
      }
      releases.push(parsed.data);
      availability.set(key, "online");
    },
    async present(input) {
      const parsed = devicePresence.safeParse(input);
      if (!parsed.success) {
        refuse(new Error(`Presence refused: ${z.prettifyError(parsed.error)}`));
      }
      presented.push([...parsed.data.keys]);
      // As the core does: the driver's other devices are offline.
      const keys = new Set(parsed.data.keys);
      for (const key of registered.keys()) {
        if (!keys.has(key) && !removing.has(key)) {
          availability.set(key, "offline");
        }
      }
    },
    async firmware(input) {
      const parsed = deviceFirmware.safeParse(input);
      if (!parsed.success) {
        refuse(new Error(`Firmware refused: ${z.prettifyError(parsed.error)}`));
      }
      if (!registered.has(parsed.data.key)) {
        refuse(new ActionError("not_found", `No device ${parsed.data.key}`));
      }
      firmware.push(parsed.data);
    },
    emit: absent,
    async follow(name) {
      followed.add(name);
    },
    scheduleJob: absent,
    cancelJob: absent,
    jobs: absent,
    putWorkflow: absent,
    removeWorkflow: absent,
    workflows: absent,
    async joining(input) {
      const parsed = deviceJoining.safeParse(input);
      if (!parsed.success) {
        refuse(new Error(`Joining refused: ${z.prettifyError(parsed.error)}`));
      }
      joining.push(parsed.data);
    },
    async problem(input) {
      const parsed = deviceProblemReport.safeParse(input);
      if (!parsed.success) {
        refuse(new Error(`Problem refused: ${z.prettifyError(parsed.error)}`));
      }
      const { key, problem } = parsed.data;
      if (!registered.has(key)) {
        refuse(new ActionError("not_found", `No device ${key}`));
      }
      if (problem === null) {
        problems.delete(key);
        return;
      }
      const shown = shownProblem(app.driver, problem);
      if (!shown) {
        refuse(new Error(`${app.id} declares no problem ${problem}`));
      }
      problems.set(key, shown);
    },
    async found(input) {
      const parsed = foundDevices.safeParse(input);
      if (!parsed.success) {
        refuse(new Error(`Found refused: ${z.prettifyError(parsed.error)}`));
      }
      if (!app.driver?.add) {
        refuse(new Error(`${app.id} lists devices it found but cannot add`));
      }
      found = parsed.data.map((each) => {
        const asks = shownQuestions(app.driver, each.asks);
        if (asks.length !== each.asks.length) {
          refuse(
            new Error(`${app.id} asks something adding it doesn't declare`),
          );
        }
        return {
          driver: app.id,
          key: each.key,
          name: each.name,
          description: each.description,
          type: each.type,
          asks,
        };
      });
    },
    ...secretCalls,
    log() {},
  };
  for (const name of options.unanswered ?? []) {
    core[name] = (async () => {
      throw new Error(`The core did not answer ${name}`);
    }) as never;
  }

  const context = (actor: Actor): AppContext =>
    createAppContext({ appId: app.id, actor, core });
  // The start hook's, which keeps the handlers of the events it follows.
  const own = createAppContext({
    appId: app.id,
    actor: { kind: "app", id: app.id },
    core,
    handlers,
  });
  const person = () => context({ kind: "user", id: "suite" });

  function driver() {
    if (!app.driver) {
      throw new Error(`${app.id} is not a driver app`);
    }
    return app.driver;
  }

  return {
    registered,
    reports,
    presses,
    releases,
    availability,
    joining,
    firmware,
    refused,
    presented,
    secrets,
    problems,
    /** The devices the driver last said it could add, but those it has registered. */
    get found() {
      return found.filter((each) => !registered.has(each.key));
    },

    start: async () => app.start?.(own, { reason: "started" }),
    /** As the core does once it restarted while the driver ran on. */
    resume: async () => app.resume?.(own, { reason: "started" }),
    stop: async () => app.stop?.(own, { reason: "shutdown" }),

    /** Hands the driver a command, as the core does, from a person. */
    command(
      key: string,
      capability: string,
      kind: CapabilityKind,
      command: Record<string, unknown>,
    ) {
      return driver().command(person(), {
        key,
        device: `device:${key}`,
        capability,
        kind,
        command,
      } as DriverCommand);
    },

    /** Has the driver move one of its lights, as the core does while a remote is held. */
    move(key: string, capability: string, move: LightMove) {
      const hook = driver().move;
      if (!hook) {
        throw new Error(`${app.id} cannot move lights`);
      }
      return hook(person(), {
        key,
        device: `device:${key}`,
        capability,
        move,
      });
    },

    /** Lets new devices join for `seconds`, as the core does when someone adds devices. */
    openPairing(seconds: number) {
      const pairing = driver().pairing;
      if (!pairing) {
        throw new Error(`${app.id} cannot pair`);
      }
      return pairing.open(person(), { seconds });
    },

    closePairing() {
      return driver().pairing!.close(person());
    },

    /** Has the driver remove one of its devices, as the core does for someone. */
    async remove(key: string, force = false) {
      const target = driver();
      if (!target.remove) {
        throw new Error(`${app.id} cannot remove devices`);
      }
      removing.add(key);
      try {
        await target.remove(person(), {
          key,
          device: `device:${key}`,
          force,
        } satisfies DriverRemoval);
      } finally {
        removing.delete(key);
      }
      const device = registered.get(key);
      registered.delete(key);
      availability.delete(key);
      problems.delete(key);
      if (device) {
        await deliver({ name: "device.deleted", device: infoOf(device) });
      }
    },

    /** Hands the driver one of the core's events, if it follows it. */
    deliver,

    /** Runs one of the app's actions for someone, as a client's call does. */
    async call(id: string, input: unknown) {
      const action = app.actions.find((each) => each.id === id);
      if (!action) throw new Error(`${app.id} has no action ${id}`);
      return action.output.parse(
        await action.run(person(), action.input.parse(input)),
      );
    },

    /** Its own devices as it reads them, whole with their keys. */
    devices: () => [...registered.values()].map(infoOf),

    /** Closes the app's own database, once the test is done with it. */
    close() {
      storage?.close();
    },

    /** Hands the driver a client's firmware call for one of its devices. */
    firmwareCall(hook: "check" | "update" | "stop", key: string) {
      const hooks = driver().firmware;
      if (!hooks) {
        throw new Error(`${app.id} cannot update firmware`);
      }
      return hooks[hook](person(), {
        key,
        device: `device:${key}`,
      } satisfies DriverDevice);
    },

    /** Has the driver ask one of its devices how it is now. */
    probe(key: string) {
      const probe = driver().probe;
      if (!probe) {
        throw new Error(`${app.id} cannot probe devices`);
      }
      return probe(person(), { key, device: `device:${key}` });
    },

    /**
     * Has the driver set one of its devices right with someone's answers to
     * what its problem's repair asks, as Repair does. A refusal must be one
     * the question it names declares.
     */
    async repair(key: string, answers: Record<string, string>) {
      const repair = driver().repair;
      const problem = problems.get(key);
      if (!repair || !problem?.repair) {
        throw new Error(`${key} has nothing to repair`);
      }
      const checked = answersTo(problem.repair.asks, answers);
      if (!checked) {
        refuse(new Error("Repair's answers are invalid"));
      }
      const result = await repair(person(), {
        key,
        device: `device:${key}`,
        problem: problem.id,
        answers: checked,
      });
      if (
        result !== undefined &&
        (!result || !isDeclaredRefusal(problem.repair.asks, result.refused))
      ) {
        refuse(
          new Error(`${app.id} refused a repair in words it doesn't declare`),
        );
      }
      return result;
    },

    /**
     * Has the driver add one of the devices it found with someone's answers
     * to what adding it asks, as Add devices does: once it resolves, the
     * device must be registered, unless it refused an answer in words the
     * question declares.
     */
    async add(key: string, answers: Record<string, string> = {}) {
      if (registered.has(key)) return;
      const add = driver().add;
      const listed = found.find((each) => each.key === key);
      if (!add || !listed) {
        throw new Error(`${app.id} found no device ${key} to add`);
      }
      const checked = answersTo(listed.asks, answers);
      if (!checked) {
        refuse(new Error("Adding's answers are invalid"));
      }
      const result = await add(person(), { key, answers: checked });
      if (result !== undefined) {
        if (!result || !isDeclaredRefusal(listed.asks, result.refused)) {
          refuse(
            new Error(
              `${app.id} refused an answer in words it doesn't declare`,
            ),
          );
        }
        return result;
      }
      if (!registered.has(key)) {
        refuse(new Error(`${app.id} added ${key} without registering it`));
      }
      return result;
    },

    /**
     * Hands the driver what changed on the home's network of what it looks
     * for, as itself, as the core does.
     */
    discovered(discovery: DriverDiscovery) {
      const discovered = driver().discovered;
      if (!discovered) {
        throw new Error(`${app.id} looks for nothing on the network`);
      }
      return discovered(own, discovery);
    },

    /** What the driver last said of a device's firmware, if anything. */
    firmwareOf(key: string) {
      return [...firmware].reverse().find((each) => each.key === key);
    },

    /** The latest stage a joining device reached, if any. */
    stageOf(key: string) {
      return [...joining].reverse().find((each) => each.key === key)?.stage;
    },

    /** The latest state reported for one capability, if any. */
    latest: latestOf,

    /** Waits until `check` holds, or fails after `timeoutMs`. */
    async until(check: () => boolean, what: string, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      while (!check()) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting: ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

export type DriverCore = ReturnType<typeof createDriverCore>;
