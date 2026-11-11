import type {
  ActionDefinition,
  AppContext,
  AppDefinition,
  SettingsSchema,
  StaticManifest,
} from "@meetsanctum/app-sdk";
import type { AppStorage } from "@meetsanctum/app-sdk/storage";

import type { AppContract } from "./contract.js";
import type { Origin } from "./host.js";
import type { AppUpdate } from "./commits.js";
import type { AppLink } from "./link.js";
import type { RequestsUnderWay } from "./net.js";
import type { HeldServices } from "./services.js";
import type { Supervision } from "./supervisor.js";

// An app the host has installed, wherever it runs.
export type InstalledApp = {
  // Its code, only to run: start and stop, actions and its driver. For an app
  // apart, what carries each across its socket (apart.ts).
  app: AppDefinition;
  // What it declares, and what the core checks against.
  manifest: StaticManifest;
  contract: AppContract;
  origin: Origin;
  // What it may do now: what it asks for and was granted (grants.ts), and
  // how often that changed while the core runs.
  granted: string[];
  grantsRevision: number;
  storage: AppStorage;
  actions: Map<string, ActionDefinition>;
  // Its settings' JSON Schema, for clients' forms.
  settings: SettingsSchema | null;
  // The app's connection details for each service it declares, once the
  // manager answers.
  services: HeldServices;
  // Its actions and driver calls under way, which a stop lets finish.
  calls: Set<Promise<unknown>>;
  // Its requests to the internet under way (net.ts).
  requests: RequestsUnderWay;
  // Its starts and stops as its grants change, one after another.
  lifecycle: Promise<void>;
  // Its stop hook failed, so its code may still run: it starts again only
  // when the core does.
  stopFailed?: true;
  // The context its lifecycle hooks share, acting as the app itself, from
  // start until stop.
  running?: { ctx: AppContext; storage: ReturnType<AppStorage["call"]> };
  // Someone turned it off, so it doesn't run until someone turns it on.
  off: boolean;
  // A new id for each start, including after removal and another install.
  runId: number;
  // When it runs apart: its socket, the folder of the version it runs, and how
  // its supervisor finds it.
  link?: AppLink;
  apartIn?: string;
  // What that version holds, as its folder is named for.
  digest?: string;
  supervision?: Supervision;
  // The start on a new version under way, and what it has claimed (commits.ts).
  updating?: AppUpdate;
};
