import { permissionIds, type ServiceConnection } from "@meetsanctum/app-sdk";

import type { ManagerClient } from "../manager.js";
import { ActionCallError, TimedOut, withTimeout } from "./errors.js";
import type { Origin } from "./host.js";

// The services the manager runs for apps: an app declares one by asking for
// its permission, services:<name>, and holds it while that permission is on.
// The core asks the manager for each one that is on and releases the rest,
// takes one back before its permission goes off, so the switch never shows
// off while the app can still log in, and releases them all when the app is
// removed.

export type ServiceManager = Pick<
  ManagerClient,
  "needService" | "releaseService" | "revokeService" | "servicesHeldBy"
>;

/** Each service an app holds, by name, once the manager answers. */
export type HeldServices = Map<string, Promise<ServiceConnection>>;

const servicePrefix = "services:";

// Third-party apps may not run services.
export const mayRunServices: readonly Origin[] = ["system", "official"];

/** The services an app declares. */
export function declaredServices(app: {
  permissions: readonly { id: string }[];
}) {
  return permissionIds(app.permissions)
    .filter((permission) => permission.startsWith(servicePrefix))
    .map((permission) => permission.slice(servicePrefix.length));
}

/** The service a permission is for, if it is a service's. */
export function serviceOf(permission: string) {
  return permission.startsWith(servicePrefix)
    ? permission.slice(servicePrefix.length)
    : undefined;
}

/** The permission for a service. */
export const servicePermission = (name: string) => `${servicePrefix}${name}`;

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createAppServices(options: {
  manager: ServiceManager;
  timeoutMs: number;
  log: (message: string) => void;
}) {
  const { manager, timeoutMs, log } = options;
  // A request still on its way, settled either way.
  const settled = (pending: Promise<unknown>) =>
    pending.then(
      () => undefined,
      () => undefined,
    );

  // What may still DELETE an app's service: a release at start, which can
  // retry while the manager is down, a revocation, which a removal does not
  // wait for, and a removal, from before it yields until it has released.
  // A new request for the same app and service waits for all of them, or a
  // late DELETE could erase its login.
  const releasing = new Map<string, Promise<void>>();
  // An app installed again supersedes a lookup still on its way, before it can
  // release a service the new installation now declares and holds.
  const serviceLookups = new Map<string, symbol>();

  function track(key: string, release: Promise<unknown>) {
    const previous = releasing.get(key);
    const all = previous
      ? Promise.all([previous, settled(release)]).then(() => undefined)
      : settled(release);
    releasing.set(key, all);
    void all.then(() => {
      if (releasing.get(key) === all) releasing.delete(key);
    });
  }

  // The app is removed: the manager gives up every service it held,
  // keeping their data.
  async function releaseAll(appId: string, held: HeldServices) {
    await Promise.all(
      [...held].map(async ([name, granted]) => {
        // After the request has settled, so the two cannot cross on
        // their way to a manager that is not answering yet.
        await settled(granted);
        try {
          await manager.releaseService(name, appId);
          log(`apps: released ${name} for ${appId}`);
        } catch (error) {
          log(
            `apps: could not release ${name} for ${appId} (${message(error)})`,
          );
        }
      }),
    );
  }

  return {
    // Asks the manager to run a service for the app; resolves with what
    // the app needs to use it, a new login when it had none.
    request(appId: string, name: string) {
      const release = releasing.get(`${appId}/${name}`);
      const connection = release
        ? release.then(() => manager.needService(name, appId))
        : manager.needService(name, appId);
      connection.then(
        () => log(`apps: ${name} runs for ${appId}`),
        (error) =>
          log(
            `apps: the manager did not run ${name} for ${appId} (${message(error)})`,
          ),
      );
      return connection;
    },

    // A service whose permission is off has no account: the manager drops
    // what it kept for the app, as after a grant switched off while the
    // core was down.
    releaseOff(appId: string, name: string) {
      const release = manager.releaseService(name, appId);
      track(`${appId}/${name}`, release);
      release.then(
        () =>
          log(`apps: ${appId} holds no ${name} while its permission is off`),
        (error) =>
          log(
            `apps: the manager did not release ${name} for ${appId} (${message(error)})`,
          ),
      );
    },

    // What the manager still keeps for it that this version doesn't declare goes,
    // such as what a version that failed asked for, so no account is left behind.
    // One it declares is seen to with its permission.
    releaseUndeclared(appId: string, declared: readonly string[]) {
      const lookup = Symbol(appId);
      serviceLookups.set(appId, lookup);
      manager.servicesHeldBy(appId).then(
        (names) => {
          if (serviceLookups.get(appId) !== lookup) return;
          serviceLookups.delete(appId);
          for (const name of names) {
            if (!declared.includes(name)) this.releaseOff(appId, name);
          }
        },
        (error) => {
          if (serviceLookups.get(appId) !== lookup) return;
          serviceLookups.delete(appId);
          log(
            `apps: could not read which services ${appId} holds (${message(error)})`,
          );
        },
      );
    },

    // Takes a service back before its permission goes off: a request for
    // it still on its way would cross the revocation, so it settles first,
    // then the manager confirms the app's broker account is gone. Rejects
    // as unavailable, holding it still, when either does not happen in
    // time.
    revoke(appId: string, held: HeldServices, name: string) {
      const pending = held.get(name);
      const revocation = (async () => {
        try {
          if (pending) {
            await withTimeout(settled(pending), timeoutMs);
          }
          await manager.revokeService(name, appId);
        } catch (error) {
          log(
            `apps: could not take ${name} back from ${appId} (${error instanceof TimedOut ? "timed out" : message(error)})`,
          );
          throw new ActionCallError("unavailable");
        }
        held.delete(name);
        log(`apps: took ${name} back from ${appId}`);
      })();
      track(`${appId}/${name}`, revocation);
      return revocation;
    },

    // The app is being removed: from now until the returned release has
    // run, a new request for its services waits. Called before the removal
    // yields, so an app installed again meanwhile cannot slip in first.
    removing(appId: string, held: HeldServices) {
      let released!: () => void;
      const barrier = new Promise<void>((resolve) => (released = resolve));
      for (const name of held.keys()) {
        track(`${appId}/${name}`, barrier);
      }
      return async () => {
        try {
          await releaseAll(appId, held);
        } finally {
          released();
        }
      };
    },
  };
}
