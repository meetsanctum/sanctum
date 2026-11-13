import {
  ActionError,
  createAppContext,
  entityTypeOf,
  light as lightKind,
  type Actor,
  type AppDefinition,
  type AppSettings,
  type CapabilityInfo,
  type CoreCalls,
  type CoreEventHandlers,
  type DeviceInfo,
  type HomeLocation,
  type Job,
  type LightCommand,
  type LightFeatures,
  type LightState,
  permissionIds,
} from "@meetsanctum/app-sdk";
import { createTestStorage } from "@meetsanctum/app-testkit";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

const stores: ReturnType<typeof createTestStorage>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

// A core for natural light's tests: where the home is, lights that take
// commands as the core's Devices does, saying who last set them, and the
// entities the app publishes, each checked against the type it declares.
// A light that is off and asked for a look holds it, and comes back at it
// when switched on. The household changing the app's settings reaches its
// start context as settings.changed.

type LightCapability = Extract<CapabilityInfo, { kind: "light" }>;

export const zurich: HomeLocation = {
  latitude: 47.3769,
  longitude: 8.5417,
  elevation: null,
  timeZone: "Europe/Zurich",
};

const ambiance: LightFeatures = {
  brightness: true,
  colorTemperature: { min: 153, max: 454 },
  color: true,
};

export function fakeCore(app: AppDefinition, clock: () => Date) {
  const storage = createTestStorage({
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  stores.push(storage);
  const state = {
    location: zurich as HomeLocation | null,
    devices: [] as DeviceInfo[],
    entities: new Map<string, { type: string; name: string; state: unknown }>(),
    // The commands the app sent, in order.
    sent: [] as { device: string; command: LightCommand; actor: Actor }[],
    jobs: [] as Job[],
    logs: [] as string[],
    beforeCommand: null as (() => Promise<void>) | null,
    // What the household chose in Settings → Apps; the app applies its
    // defaults.
    settings: {} as AppSettings,
  };

  function capabilityOf(device: string, capability = "light") {
    const found = state.devices
      .find((each) => each.id === device)
      ?.capabilities.find((each) => each.id === capability);
    if (!found || found.kind !== "light") {
      throw new ActionError("not_found");
    }
    return found as LightCapability;
  }

  /** Carries out a command for a light, from `app` (null for a client's own). */
  function set(
    device: string,
    command: LightCommand,
    by: { app: string | null; actor: Actor },
  ) {
    const capability = capabilityOf(device);
    const parsed = lightKind.command.parse(command);
    if (!lightKind.supports(capability.features, parsed)) {
      throw new Error("The light cannot do that");
    }
    const shown: LightState = { ...capability.state! };
    const { transitionSeconds: _, ...look } = parsed;
    if (look.brightness === 0) {
      delete look.brightness;
      look.on = false;
    }
    if (look.colorTemperature !== undefined) {
      shown.colorMode = "temperature";
      delete shown.hue;
      delete shown.saturation;
    }
    if (look.hue !== undefined) {
      shown.colorMode = "color";
      delete shown.colorTemperature;
    }
    Object.assign(shown, look);
    if (look.on === undefined && look.brightness !== undefined) {
      shown.on = true;
    }
    capability.state = shown;
    capability.observed = shown;
    capability.setBy = {
      app: by.app,
      actor: by.actor,
      asked: lightKind.desired(parsed),
      at: clock().toISOString(),
    };
    return capability;
  }

  const absent = async (): Promise<never> => {
    throw new Error("Natural light does not use this call");
  };
  const holds = (permission: string) => {
    if (!permissionIds(app.permissions).includes(permission)) {
      throw new Error(`Natural light does not hold ${permission}`);
    }
  };

  // What the start context follows, which ctx.events.on() keeps here.
  const handlers: CoreEventHandlers = new Map();

  function context(actor: Actor, followed?: CoreEventHandlers) {
    const core: CoreCalls = {
      query: storage.query,
      serviceConnection: absent,
      permissions: async () => permissionIds(app.permissions),
      permissionsRevision: async () => 0,
      people: absent,
      places: absent,
      register: absent,
      report: absent,
      present: absent,
      press: absent,
      release: absent,
      async settings() {
        return state.settings;
      },
      firmware: absent,
      joining: absent,
      secret: absent,
      putSecret: absent,
      removeSecret: absent,
      entities: absent,
      fetch: absent,
      emit: absent,
      follow: async (name) => {
        if (name !== "settings.changed") {
          throw new Error(`Natural light does not follow ${name}`);
        }
      },
      async scheduleJob(job) {
        state.jobs = state.jobs.filter((each) => each.key !== job.key);
        const scheduled = {
          ...job,
          when: job.when as Job["when"],
          nextAt: null,
        };
        state.jobs.push(scheduled);
        return scheduled;
      },
      async cancelJob(key) {
        state.jobs = state.jobs.filter((each) => each.key !== key);
      },
      async jobs() {
        return state.jobs;
      },
      putWorkflow: absent,
      removeWorkflow: absent,
      workflows: absent,
      async location() {
        holds("places.location");
        return state.location;
      },
      async devices() {
        holds("devices.control:light");
        return structuredClone(state.devices);
      },
      async device(id) {
        holds("devices.control:light");
        const device = state.devices.find((each) => each.id === id);
        if (!device) throw new ActionError("not_found");
        return structuredClone(device);
      },
      async command({ device, capability, command }) {
        holds("devices.control:light");
        capabilityOf(device, capability);
        await state.beforeCommand?.();
        state.sent.push({ device, command: command as LightCommand, actor });
        return structuredClone(
          set(device, command as LightCommand, { app: app.id, actor }),
        );
      },
      async publish(entity) {
        const type = entityTypeOf(app, entity.type);
        if (!type) {
          throw new Error(`Natural light does not provide ${entity.type}`);
        }
        state.entities.set(entity.key, {
          type: entity.type,
          name: entity.name,
          state: type.state.parse(entity.state),
        });
      },
      async unpublish(key) {
        state.entities.delete(key);
      },
      log: (message) => state.logs.push(message),
    };
    return createAppContext({
      appId: app.id,
      actor,
      core,
      ...(followed ? { handlers: followed } : {}),
    });
  }

  return {
    state,
    /** The context the app's start hook gets, acting as the app itself. */
    ctx: context({ kind: "app", id: app.id }, handlers),
    /** The household changes the app's settings, as Settings → Apps does. */
    async changeSettings(settings: AppSettings) {
      const before = state.settings;
      state.settings = settings;
      for (const handler of handlers.get("settings.changed") ?? []) {
        await handler({ name: "settings.changed", settings, before });
      }
    },
    /** The context of an action a person calls. */
    as: (actor: Actor) => context(actor),
    set,
    /** Adds a light, on or off, that takes colour temperatures unless told otherwise. */
    addLight(
      id: string,
      name: string,
      shown: LightState | null,
      features: LightFeatures = ambiance,
    ) {
      state.devices.push({
        id,
        name,
        driver: "test.lamps",
        manufacturer: null,
        model: null,
        roomId: null,
        driverName: name,
        type: "light",
        availability: "online",
        lastSeenAt: null,
        firmware: null,
        probe: false,
        battery: null,
        leftAt: null,
        capabilities: [
          {
            id: "light",
            kind: "light",
            features,
            state: shown,
            observed: shown,
            desired: null,
            sync: "synced",
            setBy: null,
            changedAt: null,
          },
        ],
      });
    },
    light: (device: string) => capabilityOf(device),
    /** Something other than the core changed it, such as its wall switch. */
    press(device: string, shown: Partial<LightState>) {
      const capability = capabilityOf(device);
      capability.state = { ...capability.state!, ...shown };
      capability.observed = capability.state;
    },
  };
}
