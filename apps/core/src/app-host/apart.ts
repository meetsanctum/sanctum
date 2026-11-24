import type {
  ActionDefinition,
  AppContext,
  AssistantRequestCall,
  AppDefinition,
  CoreCalls,
  RequestContext,
  StartInfo,
  StaticManifest,
  StopInfo,
} from "@meetsanctum/app-sdk";
import type { CallBody, DriverHook } from "@meetsanctum/app-sdk/protocol";
import type { AppStorage } from "@meetsanctum/app-sdk/storage";
import { z } from "zod";

import type { AppLink } from "./link.js";

// An app in its own container, as the host sees it: the shape of an app whose
// every hook, action and driver call crosses the socket, so what the host does
// around a call is one piece of code: the gate, the activity log, events held
// until a call succeeds, what a call may do. Its own schemas parse on its
// side, and the core checks what results against the manifest of the version
// it runs.

/** How long an app apart has to stop, which is less than any other call. */
export const stopLimitMs = (timeoutMs: number) => Math.min(timeoutMs, 10_000);

/** How long an app's uninstall hook has, as someone removes it. */
export const uninstallLimitMs = 30_000;

// The protocol whose runners take an uninstall call.
const uninstallFrom = 9;

/** The core's calls behind a context, so a call's id can be tied to them. */
export type CoreOf = (ctx: RequestContext) => CoreCalls;

export function apartApp(
  manifest: StaticManifest,
  link: AppLink,
  coreOf: CoreOf,
  timeoutOf: (ctx: RequestContext) => number,
  // The update its next start commits, if any.
  updateOf: () => string | undefined,
): AppDefinition {
  const call = (
    ctx: RequestContext,
    body: CallBody,
    deadlineMs = timeoutOf(ctx),
  ) => link.call(coreOf(ctx), ctx.actor, body, deadlineMs);
  const hook = (name: DriverHook) => (ctx: AppContext, params?: unknown) =>
    call(ctx, { kind: "driver", hook: name, params }) as Promise<never>;
  const hooks = (manifest.driver?.hooks ?? []) as readonly string[];
  const has = <T>(name: string, made: T) => (hooks.includes(name) ? made : {});
  return {
    id: manifest.id,
    actions: manifest.actions.map(({ id, title, tier }): ActionDefinition => ({
      id,
      title,
      tier,
      input: z.unknown(),
      output: z.unknown(),
      run: (ctx, input) => call(ctx, { kind: "action", action: id, input }),
    })),
    start: async (ctx: AppContext, info: StartInfo) => {
      const update = updateOf();
      const answer = await call(ctx, {
        kind: "start",
        ...info,
        ...(update ? { update } : {}),
      });
      // This connection said it, since nothing else answers this call, so what
      // it wrote can't be from an earlier run.
      if (
        update &&
        (answer as { synced?: string } | undefined)?.synced !== update
      ) {
        throw new Error(`${manifest.id} didn't say its data is on the disk`);
      }
    },
    stop: async (ctx: AppContext, info: StopInfo) => {
      await call(ctx, { kind: "stop", ...info }, stopLimitMs(timeoutOf(ctx)));
    },
    // A runner built before it can't take the call, and its app has none.
    ...(manifest.protocol >= uninstallFrom
      ? {
          uninstall: async (ctx: AppContext) => {
            await call(ctx, { kind: "uninstall" }, uninstallLimitMs);
          },
        }
      : {}),
    // Sanctum's Assistant answers requests within its turn's time.
    ...(manifest.requests
      ? {
          requests: async (
            ctx: RequestContext,
            { text, language, clientName }: AssistantRequestCall,
          ) => {
            await call(ctx, {
              kind: "request",
              request: { text, language, clientName },
            });
          },
        }
      : {}),
    ...(manifest.driver
      ? {
          driver: {
            command: hook("command"),
            ...has("move", { move: hook("move") }),
            ...has("pairing", {
              pairing: {
                open: hook("pairing.open"),
                close: hook("pairing.close"),
              },
            }),
            ...has("remove", { remove: hook("remove") }),
            ...has("firmware", {
              firmware: {
                check: hook("firmware.check"),
                update: hook("firmware.update"),
                stop: hook("firmware.stop"),
              },
            }),
            ...has("probe", { probe: hook("probe") }),
            ...has("identify", { identify: hook("identify") }),
            ...has("repair", { repair: hook("repair") }),
            ...has("discovered", { discovered: hook("discovered") }),
            ...has("add", { add: hook("add") }),
            ...has("cancelAdd", { cancelAdd: hook("cancelAdd") }),
            ...has("cancelRepair", { cancelRepair: hook("cancelRepair") }),
          },
        }
      : {}),
    // The host uses only these of an app apart; the rest of what it declares is
    // its manifest's.
  } as unknown as AppDefinition;
}

/**
 * What stands in for its database, which is in its container. A call's scope is
 * all the host still uses of it: whether the call has ended.
 */
export function apartStorage(appId: string): AppStorage {
  let closed = false;
  return {
    async sync() {},
    call() {
      let ended = false;
      return {
        async query() {
          throw new Error(`${appId}'s database is in its own container`);
        },
        get ended() {
          return ended || closed;
        },
        end() {
          ended = true;
        },
      };
    },
    close() {
      closed = true;
    },
  };
}
