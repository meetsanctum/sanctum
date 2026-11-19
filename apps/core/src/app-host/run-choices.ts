import { lanPort } from "@meetsanctum/app-sdk";

import type { Presses } from "../devices/presses.js";
import { appStateOf } from "./app-info.js";
import { deviceKinds } from "./calls.js";
import type { createDiscoveryHandOut } from "./discovered.js";
import type { InstalledApp } from "./installed.js";
import type { LanPolicies } from "./lan.js";
import type { AppsOff } from "./off.js";
import {
  mayRunServices,
  serviceOf,
  type createAppServices,
} from "./services.js";
import type { Supervisor } from "./supervisor.js";
import type { WaitingUpdates } from "./waiting.js";

// What follows the household's choices of whether and how an installed app
// runs: turning it off or on, asking again for one that stopped for good, and
// switching its permissions. The services it holds follow its grants: one
// switched off loses its broker account before the switch shows it off, and
// one switched back on gets a new login.
export function createAppRunChoices(options: {
  installed: ReadonlyMap<string, InstalledApp>;
  off: Pick<AppsOff, "set">;
  waiting: Pick<WaitingUpdates, "forget">;
  presses: () => Pick<Presses, "endCaptures">;
  appServices: Pick<ReturnType<typeof createAppServices>, "revoke" | "request">;
  lan: Pick<LanPolicies, "switchingOff" | "sync" | "hasNetwork">;
  // What drivers hear of the home's network, once the host has it.
  handOut: () =>
    Pick<ReturnType<typeof createDiscoveryHandOut>, "sync"> | undefined;
  supervisor: Pick<Supervisor, "turnedOff" | "restart" | "renew">;
  reconcile: (
    entry: InstalledApp,
    options?: { restartFor?: string },
  ) => Promise<void>;
  startApart: (entry: InstalledApp) => Promise<void>;
  announce: (entry: InstalledApp) => void;
  markDriverOffline: (entry: InstalledApp) => void;
  log: (message: string) => void;
}) {
  const {
    installed,
    appServices,
    lan,
    supervisor,
    reconcile,
    startApart,
    announce,
    markDriverOffline,
    log,
  } = options;
  const followingOff = new WeakMap<InstalledApp, Promise<void>>();

  async function followOff(entry: InstalledApp) {
    await reconcile(entry);
    if (installed.get(entry.app.id) !== entry) return;
    if (entry.off) {
      markDriverOffline(entry);
      await supervisor.turnedOff(entry);
    } else if (!entry.link.isConnected()) {
      // Back on the connection it never lost, if someone was quick; otherwise it
      // needs a new container, which says when it's ready.
      startApart(entry);
    }
    announce(entry);
  }

  return {
    // It stops, or starts again, after whatever it's doing now. A driver's devices
    // are offline meanwhile, and it says otherwise as it comes back.
    onOff(entry: InstalledApp, off: boolean) {
      if (entry.off === off) return;
      options.off.set(entry.app.id, off);
      entry.off = off;
      announce(entry);
      // One at a time for an app, each doing what was last asked for: its stop can
      // take seconds, and someone can change their mind while it does.
      const work = (followingOff.get(entry) ?? Promise.resolve())
        .then(() => followOff(entry))
        .catch((error: unknown) => {
          log(
            `apps: ${entry.app.id} didn't follow Turn off (${String(error)})`,
          );
        });
      followingOff.set(entry, work);
    },
    // Only one its supervisor has given up on.
    onRestart(entry: InstalledApp) {
      if (entry.supervision.phase !== "failed") return false;
      void supervisor.restart(entry);
      return true;
    },
    // A permission that narrows what it reaches waits for the manager to
    // confirm the narrower policy, which cuts its connections first.
    beforeOff(entry: InstalledApp, permission: string) {
      const service = serviceOf(permission);
      return lan.switchingOff(
        entry,
        permission,
        service
          ? appServices.revoke(entry.app.id, entry.services, service)
          : undefined,
      );
    },
    // What it set going under a permission that is off ends, a service
    // switched back on gets a new login, and it pauses, starts or restarts.
    onPermission(entry: InstalledApp, permission: string, granted: boolean) {
      // Its switches can also grant what an installed waiting build needs.
      if (
        granted &&
        entry.waiting?.build === entry.apartIn &&
        entry.waiting.needs.every((need) => entry.granted.includes(need.id))
      ) {
        options.waiting.forget(entry.app.id);
        delete entry.waiting;
      }
      const service = serviceOf(permission);
      if (granted && service && mayRunServices.includes(entry.origin)) {
        entry.services.set(service, appServices.request(entry.app.id, service));
      }
      if (!granted) {
        const isPaused = appStateOf(entry) === "paused";
        // Ending these cannot wait behind a start hook, which may itself
        // be waiting for one of the requests we must abort.
        if (isPaused) entry.requests.end();
        else entry.requests.revoke(permission);
        if (isPaused || !deviceKinds(entry.granted).reads.has("button")) {
          options.presses().endCaptures(entry.app.id);
        }
      }
      // Granted to look, or no longer: it hears of what that finds, or that
      // it's gone, within what it may reach. One given a network of its own
      // needs a container that has one.
      lan.sync();
      options.handOut()?.sync();
      if (granted && lanPort(permission) !== null && !lan.hasNetwork(entry)) {
        void supervisor.renew(entry);
      }
      const settled = reconcile(
        entry,
        service ? { restartFor: "its changed services" } : {},
      );
      // One taken away pauses it at once. One given back has it starting
      // at once, which its supervisor announces, and is announced again once
      // it runs, so no client sees it running before it takes calls.
      if (granted) void settled.then(() => announce(entry));
      else announce(entry);
    },
  };
}
