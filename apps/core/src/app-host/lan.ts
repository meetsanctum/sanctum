import {
  discoveredServices,
  lanRanges,
  lanRangesWithin,
  pausedBy,
  type LanRange,
  type Sighting,
} from "@meetsanctum/app-sdk";

import type { LanVersion } from "../manager-answers.js";
import {
  ManagerRefusal,
  ManagerUnavailable,
  type LanPolicy,
  type LanPort,
} from "../manager.js";
import type { InstalledApp } from "./installed.js";

// What an app that holds lan:tcp: may reach: the addresses of the devices it
// found, on its ports, and nothing while it's paused, turned off or not
// granted. Its ports go to the manager one entry for each permission, a port
// or a range [from, to], and are compared by the ports they cover. The manager loads the first policy into the app's own network,
// its holder's, before the app's container starts, and the core hands it
// each change after, one at a time. Each policy's version names this run of
// the core and a count, and the manager's confirmation names its own run and
// the holder; the core counts a confirmation only for the policy it sent
// last. An app hears of an address only once a confirmed policy holds it,
// and switching off a permission that narrows its policy waits until the
// manager has confirmed the narrower one, so its connections are cut before
// Sanctum says it's done. A holder the manager no longer has took the app's
// network with it; the next start brings its rules again.

const againMs = 5_000;

type Reach = { addresses: string[]; ports: LanPort[] };

const nothing: Reach = { addresses: [], ports: [] };

const rangeOf = (port: LanPort): LanRange =>
  typeof port === "number"
    ? { from: port, to: port }
    : { from: port[0], to: port[1] };

const portOf = ({ from, to }: LanRange): LanPort =>
  from === to ? from : [from, to];

// Whether everything `inner` lets through, `outer` lets through too.
const within = (inner: Reach, outer: Reach) =>
  inner.addresses.every((each) => outer.addresses.includes(each)) &&
  lanRangesWithin(inner.ports.map(rangeOf), outer.ports.map(rangeOf));

const both = (a: Reach, b: Reach): Reach => ({
  addresses: [...new Set([...a.addresses, ...b.addresses])],
  ports: [
    ...new Map(
      [...a.ports, ...b.ports].map((port) => [String(port), port]),
    ).values(),
  ],
});

type Waiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

type State = {
  entry: InstalledApp;
  // The manager's run and the holder its rules are in, and what they let
  // through, as the manager last confirmed.
  at?: { manager: string; holder: string };
  confirmed?: Reach;
  // A request whose answer was lost may already have changed the rules.
  unconfirmed?: Reach;
  // The policy on its way to the manager, which may hold already.
  sending?: LanPolicy;
  // Permissions being switched off, left out of what it should reach.
  taking: Set<string>;
  waiters: Waiter[];
  retry?: NodeJS.Timeout;
};

/** What the manager does with an app's policies. */
export type LanManager = {
  applyLanPolicy(
    app: string,
    policy: LanPolicy & { manager: string; holder: string },
  ): Promise<LanVersion>;
};

/** Whether an app reaches devices on the home's network. */
export const reachesDevices = (entry: InstalledApp) =>
  lanRanges(entry.granted).length > 0;

/**
 * Whether an app's manifest asks for a range of ports, switched on or not, so
 * it runs only under a manager whose rules take one: switching it on later
 * mustn't find a manager that can't.
 */
export const asksForPortRange = (entry: InstalledApp) =>
  lanRanges(entry.manifest.permissions.map((each) => each.id)).some(
    (range) => range.from < range.to,
  );

export function createLanPolicies(options: {
  // This run of the core, which names its policies.
  core: string;
  manager: LanManager;
  installed: ReadonlyMap<string, InstalledApp>;
  sightings: () => readonly Sighting[];
  // What an app's rules let through changed, so what it hears of may too.
  onReach: (appId: string) => void;
  log: (message: string) => void;
  againMs?: number;
}) {
  const { installed, log } = options;
  const states = new Map<string, State>();
  let count = 0;

  function forget(appId: string) {
    const state = states.get(appId);
    if (!state) return;
    clearTimeout(state.retry);
    states.delete(appId);
    // Its network goes with it.
    for (const waiter of state.waiters.splice(0)) waiter.resolve();
  }

  // A new install, or a later one, starts afresh.
  function stateOf(entry: InstalledApp) {
    const appId = entry.app.id;
    let state = states.get(appId);
    if (state?.entry !== entry) {
      forget(appId);
      state = { entry, taking: new Set(), waiters: [] };
      states.set(appId, state);
    }
    return state;
  }

  // What its rules should let through now: its found devices' addresses on
  // its ports, leaving out what's being switched off, and nothing while that
  // pauses it.
  function wanted(state: State): Reach {
    const { entry } = state;
    for (const permission of state.taking) {
      // Switched off now, so its grants leave it out themselves.
      if (!entry.granted.includes(permission)) state.taking.delete(permission);
    }
    const granted = entry.granted.filter((each) => !state.taking.has(each));
    if (entry.off || pausedBy(entry.manifest.permissions, granted).length > 0) {
      return nothing;
    }
    const ports = lanRanges(granted).map(portOf);
    if (ports.length === 0) return nothing;
    const services = new Set(discoveredServices(granted));
    const addresses = [
      ...new Set(
        options
          .sightings()
          .filter((sighting) => services.has(sighting.service))
          .flatMap((sighting) => sighting.addresses),
      ),
    ].sort();
    return { addresses, ports };
  }

  // What the manager may let through now: what it confirmed, and what's on
  // its way to it.
  function mayReach(state: State): Reach {
    return both(
      both(
        state.at ? (state.confirmed ?? nothing) : nothing,
        state.unconfirmed ?? nothing,
      ),
      state.sending ?? nothing,
    );
  }

  function settle(state: State) {
    const reach = mayReach(state);
    const next = wanted(state);
    state.waiters = state.waiters.filter((waiter) => {
      if (!within(reach, next)) return true;
      waiter.resolve();
      return false;
    });
  }

  function confirm(state: State, policy: LanPolicy, version: LanVersion) {
    if (version.core !== options.core || version.count !== policy.count) {
      return false;
    }
    state.at = { manager: version.manager, holder: version.holder };
    state.confirmed = { addresses: policy.addresses, ports: policy.ports };
    state.unconfirmed = undefined;
    options.onReach(state.entry.app.id);
    return true;
  }

  // Hands the manager what its rules should let through, once the last has
  // its answer, while the holder they're in is known.
  function push(state: State) {
    if (!state.at || state.sending || state.retry) return;
    const next = wanted(state);
    if (
      state.confirmed &&
      !state.unconfirmed &&
      within(state.confirmed, next) &&
      within(next, state.confirmed)
    ) {
      settle(state);
      return;
    }
    const appId = state.entry.app.id;
    const policy: LanPolicy = { core: options.core, count: ++count, ...next };
    const at = state.at;
    state.sending = policy;
    const isCurrent = () =>
      states.get(appId) === state && state.sending === policy;
    void options.manager
      .applyLanPolicy(appId, { ...policy, ...at })
      .then((version) => {
        if (!isCurrent()) return;
        // Its rules are the holder's, which a restarted manager keeps: its
        // new run confirms them as well, and the next policy names it.
        if (version.holder !== at.holder || !confirm(state, policy, version)) {
          throw new ManagerUnavailable("The network's rules weren't confirmed");
        }
        state.sending = undefined;
        settle(state);
        push(state);
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        state.unconfirmed = both(state.unconfirmed ?? nothing, policy);
        state.sending = undefined;
        if (error instanceof ManagerRefusal && error.status === 409) {
          // That holder no longer has the app, and its network went with it.
          state.at = undefined;
          state.confirmed = undefined;
          state.unconfirmed = undefined;
          options.onReach(appId);
          settle(state);
          return;
        }
        log(
          `apps: ${appId}'s network rules weren't changed (${String(error)})`,
        );
        // What waits for them can't be done now; asked again in a while.
        for (const waiter of state.waiters.splice(0)) waiter.reject(error);
        state.retry = setTimeout(() => {
          state.retry = undefined;
          push(state);
        }, options.againMs ?? againMs);
        state.retry.unref();
      });
  }

  const policies = {
    /** Every app's policy, as their grants and what was found say now. */
    sync() {
      for (const [appId, state] of states) {
        if (installed.get(appId) !== state.entry) forget(appId);
        else push(state);
      }
    },

    /**
     * Its container is about to start: the first policy, for the holder it
     * brings, while what it heard of waits for that holder's confirmation.
     */
    starting(entry: InstalledApp): LanPolicy | undefined {
      if (!reachesDevices(entry)) {
        forget(entry.app.id);
        return undefined;
      }
      const state = stateOf(entry);
      clearTimeout(state.retry);
      state.retry = undefined;
      state.unconfirmed = mayReach(state);
      state.at = undefined;
      state.confirmed = undefined;
      const policy: LanPolicy = {
        core: options.core,
        count: ++count,
        ...wanted(state),
      };
      state.sending = policy;
      options.onReach(entry.app.id);
      return policy;
    },

    /**
     * Its container's start answered, with the policy its rules hold, or
     * failed. Whether the manager loaded the policy it was sent.
     */
    started(
      entry: InstalledApp,
      policy: LanPolicy,
      version: LanVersion | undefined,
    ) {
      const state = states.get(entry.app.id);
      if (state?.entry !== entry || state.sending !== policy) return false;
      state.unconfirmed = both(state.unconfirmed ?? nothing, policy);
      state.sending = undefined;
      const loaded = version !== undefined && confirm(state, policy, version);
      if (loaded) {
        settle(state);
        push(state);
      } else {
        for (const waiter of state.waiters.splice(0)) {
          waiter.reject(
            new ManagerUnavailable("The network's rules weren't confirmed"),
          );
        }
      }
      return loaded;
    },

    /**
     * Someone is switching off one of an app's permissions: what's left of
     * its reach once the manager has confirmed the policy without it, or
     * nothing when that takes nothing away. Rejects, leaving the permission
     * on, when the manager can't say now.
     */
    taking(entry: InstalledApp, permission: string): Promise<void> | undefined {
      const state = states.get(entry.app.id);
      if (state?.entry !== entry) return undefined;
      state.taking.add(permission);
      const next = wanted(state);
      if (within(mayReach(state), next)) {
        state.taking.delete(permission);
        return undefined;
      }
      return new Promise<void>((resolve, reject) => {
        if (!state.at && !state.sending) {
          reject(
            new ManagerUnavailable("The network's rules weren't confirmed"),
          );
          return;
        }
        state.waiters.push({ resolve, reject });
        push(state);
      }).catch((error: unknown) => {
        // It stays on, so its reach comes back.
        state.taking.delete(permission);
        push(state);
        throw error;
      });
    },

    /** Another part of revocation failed, so the permission stays on. */
    cancelTaking(entry: InstalledApp, permission: string) {
      const state = states.get(entry.app.id);
      if (state?.entry !== entry) return;
      state.taking.delete(permission);
      push(state);
    },

    /** Whether its container has a network of its own, or one on its way. */
    hasNetwork(entry: InstalledApp) {
      const state = states.get(entry.app.id);
      return state?.entry === entry && (!!state.at || !!state.sending);
    },

    /** A driver starts only once its container's first policy is confirmed. */
    canRun(entry: InstalledApp) {
      if (!reachesDevices(entry)) return true;
      const state = states.get(entry.app.id);
      return state?.entry === entry && state.at !== undefined;
    },

    /**
     * The addresses an app may hear of: those its confirmed policy holds, or
     * null for an app that doesn't reach devices, which hears of all it may
     * look for.
     */
    reachable(entry: InstalledApp): ReadonlySet<string> | null {
      if (!reachesDevices(entry)) return null;
      const state = states.get(entry.app.id);
      return new Set(
        state?.entry === entry && state.at
          ? (state.confirmed?.addresses ?? [])
          : [],
      );
    },

    close() {
      for (const appId of [...states.keys()]) forget(appId);
    },
  };
  return {
    ...policies,

    /**
     * Someone is switching off one of an app's permissions: it goes off once
     * what else it takes back, such as a service's account, and what it
     * narrows of the app's reach are both done, or nothing when neither has
     * anything to do. When either fails it stays on, with its reach.
     */
    switchingOff(
      entry: InstalledApp,
      permission: string,
      revoking: Promise<void> | undefined,
    ) {
      const narrowing = policies.taking(entry, permission);
      if (!revoking || !narrowing) return revoking ?? narrowing;
      return Promise.all([revoking, narrowing])
        .then(() => undefined)
        .catch((error: unknown) => {
          policies.cancelTaking(entry, permission);
          throw error;
        });
    },
  };
}

export type LanPolicies = ReturnType<typeof createLanPolicies>;
