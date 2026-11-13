import {
  entityReadPermission,
  knownParts,
  standardEntityTypes,
} from "@meetsanctum/app-sdk";
import { capturePresses, type PressCaptureListener } from "./presses";
import type {
  ActionDefinition,
  ActionInput,
  ActionOutput,
  AppInfo,
  AppSettings,
  CapabilityInfo,
  CapabilityKind,
  CommandOf,
  DeviceInfo,
  EntityInfo,
  LiveMessage,
  Places,
} from "@meetsanctum/app-sdk";

// The typed client an app's pages use: its own actions, and the core calls
// its permissions allow, over the shell's requests and its one live socket.
// Each request names the app, and the core answers it with what both the
// client and the app may see; this also refuses early what the app was not
// granted, and keeps the live socket's messages to what the app may see.

export type LiveListener = {
  /** A change the core pushed, limited to what the app may see. */
  message?(message: LiveMessage): void;
  /** Read everything again: the live connection is back, or the shell refreshes. */
  refresh?(): void;
};

/** The shell's live socket, shared by every app's pages. */
export interface LiveFeed {
  subscribe(listener: LiveListener): () => void;
}

/** What the shell lends app pages: requests to the core with this client's token, its live socket, and its sheet that asks for permissions. */
export interface CoreBridge {
  /**
   * A JSON request to a core path, such as /api/places; a refusal throws.
   * One for an app's page names its app, and the core answers it with what
   * both this client and the app may see.
   */
  json<T>(
    path: string,
    init?: { method?: "GET" | "POST"; json?: unknown; app?: string },
  ): Promise<T>;
  readonly live: LiveFeed;
  /**
   * Shows the shell's sheet asking for some of an app's optional
   * permissions that are off: true once they are on, false on Not now.
   */
  ask(app: string, permissions: readonly string[]): Promise<boolean>;
}

export type CapabilityCommand<K extends CapabilityKind = CapabilityKind> = {
  [Kind in K]: {
    device: string;
    capability: string;
    kind: Kind;
    command: CommandOf<Kind>;
  };
}[K];

export interface AppClient {
  readonly app: AppInfo;
  /** Calls one of the app's own actions; `Action` is its definition's type. */
  call<Action extends ActionDefinition>(
    actionId: string,
    input: ActionInput<Action>,
  ): Promise<ActionOutput<Action>>;
  /** Needs `places.read`. */
  places(): Promise<Places>;
  /** The devices with capabilities the app may read, showing only those. */
  devices(): Promise<DeviceInfo[]>;
  /** Needs `devices.control:<kind>`. Answers the capability as it now stands. */
  command(command: CapabilityCommand): Promise<CapabilityInfo>;
  /**
   * The entities the app brings to the home, and those of the standard
   * types it reads with `entities.read:<type>`.
   */
  entities(): Promise<EntityInfo[]>;
  /**
   * The app's own settings, with its schema's defaults. Every client reads
   * them, so its pages follow them on shared devices too.
   */
  settings(): Promise<AppSettings>;
  /**
   * Asks the household, through the shell's sheet, for optional
   * permissions the app's manifest lists, where the page is about to use
   * them: true once all are on, at once when they are already, and false on
   * Not now, which asks nothing more until the next use. One the app needs,
   * or doesn't ask for, is refused. The page then has a client with them, as
   * the shell takes the core's answer.
   */
  ask(permissions: string | readonly string[]): Promise<boolean>;
  /**
   * Captures a remote's presses while someone picks one, as binding a
   * button does: needs `devices.read:button`.
   */
  capturePresses(
    device: string,
    listener: PressCaptureListener,
  ): { stop(): Promise<void> };
  subscribe(listener: LiveListener): () => void;
}

const devicePermission = /^devices\.(read|control):(.+)$/;

/** The capability kinds an app may read and control; controlling includes reading. */
export function deviceKindsOf(permissions: readonly string[]) {
  const reads = new Set<string>();
  const controls = new Set<string>();
  for (const permission of permissions) {
    const [, access, kind] = devicePermission.exec(permission) ?? [];
    if (!kind) continue;
    reads.add(kind);
    if (access === "control") controls.add(kind);
  }
  return { reads, controls };
}

// What some permissions let an app's pages reach.
function accessOf(permissions: readonly string[]) {
  return {
    held: permissions,
    kinds: deviceKindsOf(permissions),
    readsPlaces: permissions.includes("places.read"),
    readsTypes: new Set(
      standardEntityTypes
        .filter((type) => permissions.includes(entityReadPermission(type.id)))
        .map((type) => type.id),
    ),
  };
}

export function createAppClient(
  app: AppInfo,
  shellBridge: CoreBridge,
): AppClient {
  // Every request names the app.
  const bridge: CoreBridge = {
    ...shellBridge,
    json: (path, init) => shellBridge.json(path, { ...init, app: app.id }),
  };
  // What the app holds, which a granted ask adds to at once, so the client
  // that asked can use it before the shell hands its page a new one.
  let access = accessOf(app.permissions);
  // An entity the app may see: its own, or of a type it reads.
  const sees = (entity: EntityInfo) =>
    entity.app === app.id || access.readsTypes.has(entity.type);

  function need(granted: boolean, permission: string) {
    if (!granted) {
      throw new Error(`${app.id} does not hold ${permission}`);
    }
  }

  // A device as the app may see it, or null when it may see none of it.
  function seen(device: DeviceInfo): DeviceInfo | null {
    const capabilities = device.capabilities.filter((capability) =>
      access.kinds.reads.has(capability.kind),
    );
    return capabilities.length > 0 ? { ...device, capabilities } : null;
  }

  return {
    app,

    call<Action extends ActionDefinition>(
      actionId: string,
      input: ActionInput<Action>,
    ) {
      return bridge.json<ActionOutput<Action>>(
        `/api/apps/${encodeURIComponent(app.id)}/actions/${encodeURIComponent(actionId)}`,
        { method: "POST", json: input },
      );
    },

    async places() {
      need(access.readsPlaces, "places.read");
      return bridge.json<Places>("/api/places");
    },

    async devices() {
      need(access.kinds.reads.size > 0, "a devices.read: permission");
      const devices = await bridge.json<DeviceInfo[]>("/api/devices");
      return devices.flatMap((device) => seen(knownParts(device)) ?? []);
    },

    async command({ device, capability, kind, command }) {
      need(access.kinds.controls.has(kind), `devices.control:${kind}`);
      return bridge.json<CapabilityInfo>("/api/devices/command", {
        method: "POST",
        json: { device, capability, command },
      });
    },

    async entities() {
      const entities = await bridge.json<EntityInfo[]>("/api/entities");
      return entities.filter(sees);
    },

    settings() {
      return bridge.json<AppSettings>(
        `/api/apps/${encodeURIComponent(app.id)}/settings`,
      );
    },

    async ask(permissions) {
      const ids = [
        ...new Set(
          typeof permissions === "string" ? [permissions] : permissions,
        ),
      ];
      for (const id of ids) {
        const request = app.requests.find((each) => each.id === id);
        if (!request) throw new Error(`${app.id} does not ask for ${id}`);
        if (request.needed) {
          throw new Error(`${app.id} needs ${id}, so it is never asked`);
        }
      }
      const off = ids.filter((id) => !access.held.includes(id));
      if (off.length === 0) return true;
      const granted = await bridge.ask(app.id, off);
      if (granted) access = accessOf([...access.held, ...off]);
      return granted;
    },

    capturePresses(device, listener) {
      need(access.kinds.reads.has("button"), "devices.read:button");
      return capturePresses(bridge, device, listener, app.id);
    },

    subscribe(listener) {
      return bridge.live.subscribe({
        refresh: () => listener.refresh?.(),
        message(message) {
          if (message.type === "places") {
            if (access.readsPlaces) listener.message?.(message);
            return;
          }
          if (message.type === "settings") {
            if (message.app === app.id) listener.message?.(message);
            return;
          }
          if (message.type === "entity") {
            const own = message.app === app.id;
            if (own || (message.entity && sees(message.entity))) {
              // A type it was before that the app may not read stays
              // unnamed.
              const was =
                own || (message.was && access.readsTypes.has(message.was))
                  ? message.was
                  : null;
              listener.message?.({ ...message, was });
            } else if (message.was && access.readsTypes.has(message.was)) {
              // It was of a type the app reads, and is gone or now of one
              // it does not: the page lets go of it. Nothing reaches an app
              // about entities it could never see.
              listener.message?.({ ...message, entity: null });
            }
            return;
          }
          // Only buttons are pressed.
          if (message.type === "press") {
            if (access.kinds.reads.has("button")) listener.message?.(message);
            return;
          }
          // Adding devices is the shell's, and so are the home's dashboards
          // and the activity log.
          if (message.type !== "device" || access.kinds.reads.size === 0)
            return;
          listener.message?.({
            ...message,
            device: message.device && seen(message.device),
          });
        },
      });
    },
  };
}

/** The shell's side of the live socket: it publishes what the core pushes, and app pages subscribe. */
export function createLiveFeed() {
  const listeners = new Set<LiveListener>();
  return {
    subscribe(listener: LiveListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // A device arrives with the parts this build knows, for every listener.
    publish(message: LiveMessage) {
      const said =
        message.type === "device" && message.device
          ? { ...message, device: knownParts(message.device) }
          : message;
      for (const listener of listeners) listener.message?.(said);
    },
    refresh() {
      for (const listener of listeners) listener.refresh?.();
    },
  };
}
