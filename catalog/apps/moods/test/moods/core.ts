import {
  ActionError,
  createAppContext,
  entityTypeOf,
  type ActionDefinition,
  type ActionInput,
  type ActionOutput,
  type Actor,
  type CoreCalls,
  type CoreEvent,
  type CoreEventHandlers,
  type DeviceInfo,
  type DeviceCommand,
  type EntityPublication,
  type Job,
  type JobRequest,
  type Places,
  type WorkflowInfo,
  permissionIds,
} from "@meetsanctum/app-sdk";
import { createTestStorage } from "@meetsanctum/app-testkit";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";

import moodsApp from "../../src/index.js";
import { lightCapability, places } from "./home.js";

// A core for the tests that start Moods: its own database, migrated as the
// core migrates it; the places and devices a test changes; and the
// entities Moods publishes, checked against its types as the core checks
// them. It keeps Moods' start context's handlers, as the app host does,
// and hands them what a test changes, as Moods may read it.

const migrationsFolder = fileURLToPath(
  new URL("../../migrations", import.meta.url),
);
const alex: Actor = { kind: "user", id: "alex" };
const itself: Actor = { kind: "app", id: moodsApp.id };

export function startableHome(options: { devices?: DeviceInfo[] } = {}) {
  const storage = createTestStorage({ migrationsFolder });
  onTestFinished(() => storage.close());
  const state = {
    places: structuredClone(places) as Places,
    devices: structuredClone(options.devices ?? []),
    followed: [] as string[],
    // What the home has of Moods', by key, as the core keeps it.
    entities: new Map<string, EntityPublication>(),
    // How often Moods published a mood, an unchanged state included.
    publications: 0,
    // While true, the core refuses to publish or take out entities.
    refusing: false,
    // Held, the next read of the devices waits until it is let go.
    hold: null as { reached: () => void; until: Promise<void> } | null,
    // The workflows Moods keeps, by key, as the core keeps them.
    workflows: new Map<string, WorkflowInfo>(),
    // A one-shot failure for tests of app data/workflow reconciliation.
    failWorkflowPuts: 0,
    // Moods' jobs, by key, as the core keeps them.
    jobs: new Map<string, JobRequest>(),
    scheduledJobs: [] as JobRequest[],
    // The commands Moods sent, as itself or for the caller.
    commands: [] as DeviceCommand[],
    // What the household lets Moods do: all it asks for unless a test
    // takes some away (grant()).
    granted: permissionIds(moodsApp.permissions),
    // Grows with each change to what Moods may do, as the core's does.
    revision: 0,
    // Stands in for what the core's read of the devices showed, as when
    // the grants changed and back while it ran.
    readDevices: null as ((devices: DeviceInfo[]) => DeviceInfo[]) | null,
  };
  // A device as Moods may see it: only the capabilities of the kinds it
  // may read, and none at all without any.
  const reads = (kind: string) =>
    state.granted.includes(`devices.read:${kind}`) ||
    state.granted.includes(`devices.control:${kind}`);
  const seen = (device: DeviceInfo) => {
    const capabilities = device.capabilities.filter((each) => reads(each.kind));
    return capabilities.length > 0 ? { ...device, capabilities } : null;
  };
  const keepsWorkflows = () => {
    if (!state.granted.includes("workflows.manage")) {
      throw new Error("Moods does not hold workflows.manage");
    }
  };
  const handlers: CoreEventHandlers = new Map();
  const unused = async (): Promise<never> => {
    throw new Error("not in this test");
  };
  const core: CoreCalls = {
    query: storage.query,
    serviceConnection: unused,
    settings: unused,
    permissions: async () => [...state.granted],
    permissionsRevision: async () => state.revision,
    register: unused,
    report: unused,
    async device(id) {
      const found = state.devices.find((device) => device.id === id);
      const shown = found && seen(found);
      if (!shown) throw new ActionError("not_found");
      return structuredClone(shown);
    },
    location: unused,
    async publish(entity) {
      if (state.refusing) throw new Error("The core is stopping");
      const type = entityTypeOf(moodsApp, entity.type);
      if (!type) throw new Error(`Moods does not provide ${entity.type}`);
      type.state.parse(entity.state);
      if (entity.type === "moods.mood") state.publications += 1;
      state.entities.set(entity.key, structuredClone(entity));
    },
    async unpublish(key) {
      if (state.refusing) throw new Error("The core is stopping");
      state.entities.delete(key);
    },
    entities: unused,
    fetch: unused,
    people: unused,
    places: async () => structuredClone(state.places),
    async devices() {
      const hold = state.hold;
      state.hold = null;
      if (hold) {
        hold.reached();
        await hold.until;
      }
      const shown = structuredClone(
        state.devices.flatMap((device) => seen(device) ?? []),
      );
      return state.readDevices ? state.readDevices(shown) : shown;
    },
    async command(command) {
      state.commands.push(structuredClone(command));
      return lightCapability({ on: true });
    },
    present: unused,
    press: unused,
    release: unused,
    emit: unused,
    async follow(name) {
      const allowed =
        name === "permissions.changed" ||
        (name.startsWith("place.")
          ? state.granted.includes("places.read")
          : state.granted.includes("devices.control:light"));
      if (!allowed) throw new Error(`Moods may not follow ${name}`);
      state.followed.push(name);
    },
    async scheduleJob(job) {
      state.scheduledJobs.push(structuredClone(job));
      state.jobs.set(job.key, structuredClone(job));
      return { ...job, nextAt: null } as Job;
    },
    async cancelJob(key) {
      state.jobs.delete(key);
    },
    jobs: async () =>
      [...state.jobs.values()].map((job) => ({ ...job, nextAt: null }) as Job),
    async putWorkflow({ key, name, graph }) {
      keepsWorkflows();
      if (state.failWorkflowPuts > 0) {
        state.failWorkflowPuts -= 1;
        throw new Error("workflow put failed");
      }
      const workflow = {
        id: key,
        name,
        enabled: true,
        runMode: "queued",
        graph,
        version: 1,
        createdBy: null,
        app: moodsApp.id,
        appKey: key,
        problems: [],
        warnings: [],
        suspended: [],
        lastRun: null,
        nextRun: null,
        createdAt: "2026-10-30T12:00:00.000Z",
        updatedAt: "2026-10-30T12:00:00.000Z",
      } as WorkflowInfo;
      state.workflows.set(key, workflow);
      return workflow;
    },
    async removeWorkflow(key) {
      keepsWorkflows();
      state.workflows.delete(key);
    },
    async workflows() {
      keepsWorkflows();
      return [...state.workflows.values()];
    },
    firmware: unused,
    joining: unused,
    log() {},
  };
  const context = (actor: Actor) =>
    createAppContext({
      appId: moodsApp.id,
      actor,
      core,
      handlers: actor === itself ? handlers : undefined,
    });

  async function hand(event: CoreEvent) {
    if (!state.followed.includes(event.name)) return;
    for (const handler of handlers.get(event.name) ?? []) {
      await handler(structuredClone(event));
    }
  }

  return {
    storage,
    state,
    start: () => moodsApp.start!(context(itself), { reason: "started" }),
    // As the core does once it restarted while Moods ran on.
    resume: () => moodsApp.resume!(context(itself), { reason: "started" }),
    // A context acting as Moods itself, as its jobs and syncs run.
    context: () => context(itself),
    // As the core calls an action: its input and output checked.
    async call<Action extends ActionDefinition>(
      action: Action,
      input: ActionInput<Action>,
    ): Promise<ActionOutput<Action>> {
      return action.output.parse(
        await action.run(context(alex), action.input.parse(input)),
      ) as ActionOutput<Action>;
    },
    hand,
    // The household grants Moods a permission it asks for, or takes it
    // away; the core tells Moods, as it tells a running app.
    async grant(permission: string, granted: boolean) {
      const before = [...state.granted];
      state.granted = permissionIds(moodsApp.permissions).filter((each) =>
        each === permission ? granted : before.includes(each),
      );
      state.revision += 1;
      await hand({
        name: "permissions.changed",
        granted: [...state.granted],
        before,
      });
    },
    // Someone deletes a room; the core tells Moods only when it follows.
    async deleteRoom(roomId: string) {
      const room = state.places.rooms.find((each) => each.id === roomId)!;
      state.places.rooms = state.places.rooms.filter((each) => each !== room);
      await hand({ name: "place.deleted", place: { kind: "room", ...room } });
    },
    // A device reports, goes offline or moves room.
    async changeDevice(id: string, change: (device: DeviceInfo) => void) {
      const index = state.devices.findIndex((each) => each.id === id);
      const before = state.devices[index]!;
      const device = structuredClone(before);
      change(device);
      state.devices[index] = device;
      await hand({ name: "device.changed", device, before });
    },
    async addDevice(device: DeviceInfo) {
      state.devices.push(device);
      await hand({ name: "device.added", device });
    },
    async removeDevice(id: string) {
      const device = state.devices.find((each) => each.id === id)!;
      state.devices = state.devices.filter((each) => each !== device);
      await hand({ name: "device.deleted", device });
    },
    // The next read of the devices waits, once reached, until released.
    holdDevices() {
      let reached!: () => void;
      let release!: () => void;
      const reaching = new Promise<void>((resolve) => (reached = resolve));
      const until = new Promise<void>((resolve) => (release = resolve));
      state.hold = { reached, until };
      return { reached: reaching, release };
    },
  };
}
