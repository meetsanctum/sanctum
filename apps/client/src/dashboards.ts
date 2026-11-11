import type {
  AddToHome,
  DashboardBackground,
  DashboardInfo,
  OrderHome,
  RemoveFromHome,
  UpdateDashboard,
} from "@meetsanctum/app-sdk";
import type { LiveFeed } from "@meetsanctum/ui-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { coreJson } from "./core-fetch";
import { getShell } from "./shell";

// The home's dashboards, which the core keeps for the household: read
// whenever the shell refreshes its live feed, which it first does once the
// host has answered as itself and then whenever the connection comes back,
// and followed over it in between. The sidebar lists them, and the top bar
// names the one on show, with Rename in its ⋮ menu. What is on Home shows as
// it is changed here, and once the core has answered every change, what it
// has.
export function useDashboards(live: LiveFeed) {
  // None until the core has answered.
  const [dashboards, setDashboards] = useState<DashboardInfo[]>();
  // Each read and each pushed list outdates the reads still out.
  const latest = useRef(0);
  // The read for the live feed followed now, which a rename reads with.
  const refresh = useRef<(() => Promise<void>) | undefined>(undefined);
  // Changes to Home still on their way, which what the core pushes or
  // answers meanwhile would undo on screen.
  const changing = useRef(0);
  // Keep confirmed state separate so a failed refresh cannot leave an
  // unsaved optimistic edit on screen. Writes reach the core in user order.
  const confirmed = useRef<DashboardInfo[] | undefined>(undefined);
  const writes = useRef(Promise.resolve());

  useEffect(() => {
    let isStopped = false;
    const read = async () => {
      if (isStopped) return;
      const requestId = ++latest.current;
      await coreJson<DashboardInfo[]>("/api/dashboards").then(
        (list) => {
          if (
            !isStopped &&
            requestId === latest.current &&
            changing.current === 0
          ) {
            confirmed.current = list;
            setDashboards(list);
          }
        },
        () => undefined,
      );
    };
    refresh.current = read;
    const stop = live.subscribe({
      refresh: read,
      message(message) {
        if (message.type !== "dashboards" || changing.current > 0) return;
        latest.current += 1;
        confirmed.current = message.dashboards;
        setDashboards(message.dashboards);
      },
    });
    return () => {
      isStopped = true;
      refresh.current = undefined;
      changing.current = 0;
      confirmed.current = undefined;
      writes.current = Promise.resolve();
      stop();
    };
  }, [live]);

  // Answers the dashboard as renamed; a refusal throws a CoreError.
  const rename = useCallback(async (id: string, name: string) => {
    const read = refresh.current;
    const renamed = await coreJson<DashboardInfo>("/api/dashboards/update", {
      method: "POST",
      json: { id, name } satisfies UpdateDashboard,
    });
    // Read again rather than apply the answer: another client may have
    // changed it since, and a read from a feed no longer followed changes
    // nothing.
    await read?.();
    return renamed;
  }, []);

  // Shows a change to Home at once, then sends it; once the last change
  // has answered, Home is read again. A refusal throws a CoreError.
  const changeHome = useCallback(
    async (
      path: "add" | "remove" | "order",
      json: AddToHome | RemoveFromHome | OrderHome,
      show: (devices: string[]) => string[],
    ) => {
      const read = refresh.current;
      changing.current += 1;
      latest.current += 1;
      setDashboards((current) =>
        current?.map((dashboard) =>
          dashboard.kind === "home"
            ? { ...dashboard, devices: show(dashboard.devices) }
            : dashboard,
        ),
      );
      const write = writes.current.then(async () => {
        if (!read || read !== refresh.current) return;
        const updated = await coreJson<DashboardInfo>(
          `/api/dashboards/home/${path}`,
          {
            method: "POST",
            json,
          },
        );
        if (read !== refresh.current) return;
        confirmed.current = confirmed.current?.map((dashboard) =>
          dashboard.kind === "home" ? updated : dashboard,
        );
      });
      writes.current = write.catch(() => undefined);
      try {
        await write;
      } finally {
        if (read === refresh.current) {
          changing.current -= 1;
          if (changing.current === 0) {
            setDashboards(confirmed.current);
            await read?.();
          }
        }
      }
    },
    [],
  );
  const home = useMemo<OnHome>(
    () => ({
      name: dashboards?.find(isHome)?.name ?? "Home",
      devices: dashboards?.find(isHome)?.devices,
      add: (device) =>
        changeHome("add", { device }, (devices) =>
          devices.includes(device) ? devices : [...devices, device],
        ),
      remove: (device) =>
        changeHome("remove", { device }, (devices) =>
          devices.filter((each) => each !== device),
        ),
      order: (order) => changeHome("order", { devices: order }, ordered(order)),
    }),
    [dashboards, changeHome],
  );

  return { dashboards, rename, home };
}

/** What is on Home, and the ways to change it. */
export type OnHome = {
  /** What the household calls Home, which the words about it use. */
  name: string;
  /** Home's devices, in the household's order; none until the core has answered. */
  devices: readonly string[] | undefined;
  /** Last in its room. */
  add: (device: string) => Promise<void>;
  remove: (device: string) => Promise<void>;
  /** Some of Home's devices in their new order, which swap their places among the rest. */
  order: (devices: string[]) => Promise<void>;
};

export const isHome = (
  dashboard: DashboardInfo,
): dashboard is Extract<DashboardInfo, { kind: "home" }> =>
  dashboard.kind === "home";

// Home's devices with some of them in a new order, in the places they held,
// as the core orders them.
const ordered = (order: string[]) => (devices: string[]) => {
  const places = order
    .map((device) => devices.indexOf(device))
    .filter((at) => at >= 0)
    .sort((a, b) => a - b);
  if (places.length !== order.length) return devices;
  const next = [...devices];
  places.forEach((at, index) => {
    next[at] = order[index]!;
  });
  return next;
};

// How the shell draws each background (src/styles.css), and the same
// deepened for the frame around a place and as the floating sidebar's glass
// over it.
export const dashboardBackground: Record<DashboardBackground, string> = {
  mocha: "var(--dashboard-mocha)",
};
export const dashboardFrame: Record<
  DashboardBackground,
  { frame: string; glass: string }
> = {
  mocha: {
    frame: "var(--dashboard-mocha-deep)",
    glass: "var(--dashboard-mocha-glass)",
  },
};

const currentKey = "dashboard";

// Which dashboard this client shows, which it alone keeps, with the shell,
// so it outlives the page: the one it last showed, or the first when that
// one is gone or it has shown none. None until the dashboards and the one it
// showed are read.
export function useCurrentDashboard(dashboards: DashboardInfo[] | undefined) {
  // Undefined until read; null when it has shown none.
  const [chosen, setChosen] = useState<string | null>();
  useEffect(() => {
    let isStopped = false;
    const remembered = (id: string | null) => {
      // One chosen meanwhile wins.
      if (!isStopped) setChosen((now) => (now === undefined ? id : now));
    };
    getShell()
      .preferences.get(currentKey)
      .then(remembered, () => remembered(null));
    return () => {
      isStopped = true;
    };
  }, []);
  const show = useCallback((id: string) => {
    setChosen(id);
    // Where it cannot be kept, it is remembered only until the app restarts.
    getShell()
      .preferences.set(currentKey, id)
      .catch(() => undefined);
  }, []);
  const current =
    chosen === undefined
      ? undefined
      : (dashboards?.find((dashboard) => dashboard.id === chosen) ??
        dashboards?.[0]);
  // The first, once shown, stays on show when another client moves it.
  useEffect(() => {
    if (current && current.id !== chosen) show(current.id);
  }, [current, chosen, show]);
  return { current, show };
}
