import {
  createAppContext,
  entityTypeOf,
  type AppDefinition,
  type CoreCalls,
  type CoreEventHandlers,
  type HomeLocation,
  type NetRequest,
  type NetResponse,
  permissionIds,
} from "@meetsanctum/app-sdk";

import { createTestStorage } from "@meetsanctum/app-testkit";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

const stores: ReturnType<typeof createTestStorage>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

// A core for Weather's tests: where the home is, the internet as a test
// answers it, and the entities Weather publishes, each checked against the
// type it declares, as the core checks it.

export type Internet = (request: NetRequest) => Promise<NetResponse>;

export function fakeCore(app: AppDefinition) {
  const storage = createTestStorage({
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  stores.push(storage);
  const state = {
    location: null as HomeLocation | null,
    internet: (async () => {
      throw new Error("No internet in this test");
    }) as Internet,
    requests: [] as NetRequest[],
    entities: new Map<string, { type: string; name: string; state: unknown }>(),
    logs: [] as string[],
  };
  const absent = async (): Promise<never> => {
    throw new Error("Weather does not use this call");
  };
  const core: CoreCalls = {
    query: storage.query,
    serviceConnection: absent,
    settings: absent,
    permissions: async () => permissionIds(app.permissions),
    permissionsRevision: async () => 0,
    people: absent,
    places: absent,
    devices: absent,
    device: absent,
    command: absent,
    register: absent,
    report: absent,
    present: absent,
    press: absent,
    release: absent,
    firmware: absent,
    joining: absent,
    problem: absent,
    found: absent,
    secret: absent,
    putSecret: absent,
    removeSecret: absent,
    putBlob: absent,
    modelSource: absent,
    openModel: absent,
    readModel: absent,
    cancelModel: absent,
    hostResources: absent,
    aiTools: absent,
    callAiTool: absent,
    entities: absent,
    emit: absent,
    follow: async () => undefined,
    scheduleJob: absent,
    cancelJob: absent,
    jobs: absent,
    putWorkflow: absent,
    removeWorkflow: absent,
    workflows: absent,
    async location() {
      if (!permissionIds(app.permissions).includes("places.location")) {
        throw new Error("Weather does not hold places.location");
      }
      return state.location;
    },
    async publish(entity) {
      const type = entityTypeOf(app, entity.type);
      if (!type) {
        throw new Error(`Weather does not provide ${entity.type}`);
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
    async fetch(request) {
      const host = new URL(request.url).host;
      if (!permissionIds(app.permissions).includes(`net:${host}`)) {
        throw new Error(`Weather does not hold net:${host}`);
      }
      state.requests.push(request);
      return state.internet(request);
    },
    log: (message) => state.logs.push(message),
  };
  const handlers: CoreEventHandlers = new Map();
  const ctx = createAppContext({
    appId: app.id,
    actor: { kind: "app", id: app.id },
    core,
    handlers,
  });
  return {
    ctx,
    state,
    // Where the home is changes, as the core tells whoever follows that.
    moveTo(location: HomeLocation | null) {
      const before = state.location;
      state.location = location;
      for (const handler of handlers.get("location.changed") ?? []) {
        void handler({ name: "location.changed", location, before });
      }
    },
  };
}

// Open-Meteo's answer for two days in Zurich, and three hours from ten in
// the morning there.
export const openMeteoAnswer = {
  utc_offset_seconds: 3600,
  current: {
    temperature_2m: 11.4,
    apparent_temperature: 9.8,
    relative_humidity_2m: 74,
    dew_point_2m: 6.9,
    weather_code: 2,
    is_day: 1,
    wind_speed_10m: 14.2,
    wind_gusts_10m: 22.3,
    wind_direction_10m: 268,
    uv_index: 1.2,
  },
  hourly: {
    time: ["2026-10-29T10:00", "2026-10-29T11:00", "2026-10-29T12:00"],
    temperature_2m: [11.2, 12.1, 13],
    weather_code: [2, 3, 61],
    is_day: [1, 1, 1],
    precipitation_probability: [10, 20, 65],
    precipitation: [0, 0, 0.4],
    snowfall: [0, 0, 0],
  },
  daily: {
    time: ["2026-10-29", "2026-10-30"],
    temperature_2m_max: [14.2, 12.8],
    temperature_2m_min: [6.1, 7.4],
    precipitation_probability_max: [10, 65],
    weather_code: [2, 61],
    precipitation_sum: [0.4, 6.5],
    snowfall_sum: [0, 0],
    uv_index_max: [2.4, 1.1],
  },
};

export const answer = (body: unknown, status = 200): NetResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
