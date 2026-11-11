// @vitest-environment jsdom
import type { DashboardInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { useCurrentDashboard, useDashboards } from "../src/dashboards";
import { getShell, type Shell } from "../src/shell";

// The home's dashboards as the core keeps them: read, followed over the live
// socket, and renamed; and the one this client shows.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const home: DashboardInfo = {
  id: "home",
  name: "Home",
  background: "mocha",
  kind: "home",
  devices: [],
};
const kitchen: DashboardInfo = {
  id: "kitchen",
  name: "Kitchen",
  background: "mocha",
  kind: "custom",
};

let root: Root;
let container: HTMLDivElement;
let shown: ReturnType<typeof useDashboards>;

function Dashboards(props: { live: ReturnType<typeof createLiveFeed> }) {
  shown = useDashboards(props.live);
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(coreJson).mockReset();
  localStorage.clear();
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The shell refreshes its live feed once the host has answered.
async function render(live = createLiveFeed()) {
  await act(async () => {
    root.render(<Dashboards live={live} />);
  });
  await act(async () => live.refresh());
  return live;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((answer) => {
    resolve = answer;
  });
  return { promise, resolve };
}

describe("useDashboards", () => {
  it("asks nothing until the shell refreshes", async () => {
    await act(async () => {
      root.render(<Dashboards live={createLiveFeed()} />);
    });
    expect(coreJson).not.toHaveBeenCalled();
    expect(shown.dashboards).toBeUndefined();
  });

  it("reads the home's dashboards, and again when the connection is back", async () => {
    vi.mocked(coreJson)
      .mockResolvedValueOnce([home])
      .mockResolvedValueOnce([home, kitchen]);

    const live = await render();
    const first = shown.dashboards;
    await act(async () => live.refresh());

    expect(first).toEqual([home]);
    expect(shown.dashboards).toEqual([home, kitchen]);
    expect(coreJson).toHaveBeenCalledWith("/api/dashboards");
  });

  it("follows what the core pushes, over a read still out", async () => {
    let answer: (list: DashboardInfo[]) => void = () => undefined;
    vi.mocked(coreJson).mockReturnValue(
      new Promise((resolve) => (answer = resolve)),
    );

    const live = await render();
    await act(async () => {
      live.publish({ type: "dashboards", dashboards: [home, kitchen] });
      // Other changes leave them be.
      live.publish({
        type: "places",
        places: {
          home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
          floors: [],
          rooms: [],
          zones: [],
        },
      });
    });
    await act(async () => answer([home]));

    expect(shown.dashboards).toEqual([home, kitchen]);
  });

  it("renames one", async () => {
    vi.mocked(coreJson)
      .mockResolvedValueOnce([home, kitchen])
      .mockResolvedValueOnce({ ...kitchen, name: "Breakfast" })
      .mockResolvedValueOnce([home, { ...kitchen, name: "Breakfast" }]);
    await render();

    await act(async () => {
      await shown.rename("kitchen", "Breakfast");
    });

    expect(coreJson).toHaveBeenCalledWith("/api/dashboards/update", {
      method: "POST",
      json: { id: "kitchen", name: "Breakfast" },
    });
    expect(shown.dashboards).toEqual([home, { ...kitchen, name: "Breakfast" }]);
  });

  it("keeps a newer live name when an older rename response arrives", async () => {
    const rename = deferred<DashboardInfo>();
    const current = { ...kitchen, name: "Dinner" };
    vi.mocked(coreJson)
      .mockResolvedValueOnce([home, kitchen])
      .mockReturnValueOnce(rename.promise)
      .mockResolvedValueOnce([home, current]);
    const live = await render();

    const pending = shown.rename(kitchen.id, "Breakfast");
    await act(async () => {
      live.publish({ type: "dashboards", dashboards: [home, current] });
    });
    await act(async () => {
      rename.resolve({ ...kitchen, name: "Breakfast" });
      await pending;
    });

    expect(shown.dashboards).toEqual([home, current]);
  });

  it("loads the full list when a rename finishes before the initial read", async () => {
    const initial = deferred<DashboardInfo[]>();
    const renamed = { ...kitchen, name: "Breakfast" };
    vi.mocked(coreJson)
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce(renamed)
      .mockResolvedValueOnce([home, renamed]);
    await render();

    await act(async () => {
      await shown.rename(kitchen.id, renamed.name);
      initial.resolve([home, kitchen]);
    });

    expect(shown.dashboards).toEqual([home, renamed]);
  });

  it("keeps a live removal that arrives during the read after a rename", async () => {
    const refreshed = deferred<DashboardInfo[]>();
    const renamed = { ...kitchen, name: "Breakfast" };
    vi.mocked(coreJson)
      .mockResolvedValueOnce([home, kitchen])
      .mockResolvedValueOnce(renamed)
      .mockReturnValueOnce(refreshed.promise);
    const live = await render();

    const pending = shown.rename(kitchen.id, renamed.name);
    await act(async () => {});
    await act(async () => {
      live.publish({ type: "dashboards", dashboards: [home] });
      refreshed.resolve([home, renamed]);
      await pending;
    });

    expect(shown.dashboards).toEqual([home]);
  });

  it("ignores a rename response from a replaced live connection", async () => {
    const rename = deferred<DashboardInfo>();
    const current = { ...kitchen, name: "Dinner" };
    vi.mocked(coreJson)
      .mockResolvedValueOnce([home, kitchen])
      .mockReturnValueOnce(rename.promise)
      .mockResolvedValueOnce([home, current]);
    await render();

    const pending = shown.rename(kitchen.id, "Breakfast");
    await render(createLiveFeed());
    await act(async () => {
      rename.resolve({ ...kitchen, name: "Breakfast" });
      await pending;
    });

    expect(shown.dashboards).toEqual([home, current]);
    expect(coreJson).toHaveBeenCalledTimes(3);
  });
});

describe("what is on Home", () => {
  it("shows each change at once, holds what the core pushes meanwhile, then reads again", async () => {
    const added = deferred<DashboardInfo>();
    const ordered = deferred<DashboardInfo>();
    vi.mocked(coreJson).mockImplementation(async (path) =>
      path === "/api/dashboards/home/add"
        ? added.promise
        : path === "/api/dashboards/home/order"
          ? ordered.promise
          : [{ ...home, devices: ["lamp", "plug", "fan"] }, kitchen],
    );
    vi.mocked(coreJson).mockResolvedValueOnce([
      { ...home, devices: ["lamp"] },
      kitchen,
    ]);
    const live = await render();

    let adding!: Promise<void>;
    let ordering!: Promise<void>;
    await act(async () => {
      adding = shown.home.add("plug");
      ordering = shown.home.order(["plug", "lamp"]);
      // What the core pushes for the first change is older than the second.
      live.publish({
        type: "dashboards",
        dashboards: [{ ...home, devices: ["lamp", "plug"] }, kitchen],
      });
    });
    const meanwhile = shown.home.devices;
    // The order depends on the add having reached the core first.
    expect(coreJson).not.toHaveBeenCalledWith(
      "/api/dashboards/home/order",
      expect.anything(),
    );
    await act(async () => {
      added.resolve({ ...home, devices: ["lamp", "plug"] });
      await adding;
    });
    const afterOne = shown.home.devices;
    await act(async () => {
      ordered.resolve({ ...home, devices: ["plug", "lamp"] });
      await ordering;
    });

    expect(meanwhile).toEqual(["plug", "lamp"]);
    expect(afterOne).toEqual(["plug", "lamp"]);
    expect(coreJson).toHaveBeenCalledWith("/api/dashboards/home/add", {
      method: "POST",
      json: { device: "plug" },
    });
    expect(coreJson).toHaveBeenCalledWith("/api/dashboards/home/order", {
      method: "POST",
      json: { devices: ["plug", "lamp"] },
    });
    // Once both have answered, what the core has.
    expect(shown.home.devices).toEqual(["lamp", "plug", "fan"]);
    expect(shown.home.name).toBe("Home");
  });

  it("reads again after a refusal, which it passes on", async () => {
    vi.mocked(coreJson)
      .mockResolvedValueOnce([{ ...home, devices: ["lamp"] }])
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValueOnce([{ ...home, devices: ["lamp"] }]);
    await render();

    let failed: unknown;
    await act(async () => {
      await shown.home.remove("lamp").catch((error) => (failed = error));
    });

    expect(failed).toBeInstanceOf(Error);
    expect(shown.home.devices).toEqual(["lamp"]);
  });
});

describe("Home changes across connections", () => {
  it("does not send queued writes or apply old responses after replacing the feed", async () => {
    const added = deferred<DashboardInfo>();
    vi.mocked(coreJson)
      .mockResolvedValueOnce([home])
      .mockReturnValueOnce(added.promise)
      .mockResolvedValueOnce([
        { ...home, name: "Other home", devices: ["fan"] },
      ]);
    await render();
    let adding!: Promise<void>;
    let removing!: Promise<void>;
    await act(async () => {
      adding = shown.home.add("lamp");
      removing = shown.home.remove("lamp").catch(() => undefined);
    });
    await render(createLiveFeed());
    expect(shown.home.devices).toEqual(["fan"]);
    await act(async () => {
      added.resolve({ ...home, devices: ["lamp"] });
      await Promise.all([adding, removing]);
    });
    expect(shown.home.name).toBe("Other home");
    expect(shown.home.devices).toEqual(["fan"]);
    expect(coreJson).not.toHaveBeenCalledWith(
      "/api/dashboards/home/remove",
      expect.anything(),
    );
    expect(coreJson).toHaveBeenCalledTimes(3);
  });
});

describe("failed Home changes", () => {
  it("restores confirmed membership if both the write and refresh fail", async () => {
    vi.mocked(coreJson)
      .mockResolvedValueOnce([{ ...home, devices: ["lamp"] }])
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"));
    await render();
    await act(async () => {
      await shown.home.remove("lamp").catch(() => undefined);
    });
    expect(shown.home.devices).toEqual(["lamp"]);
  });

  it("continues queued changes after a refusal", async () => {
    vi.mocked(coreJson)
      .mockResolvedValueOnce([{ ...home, devices: ["lamp"] }])
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValueOnce({ ...home, devices: ["lamp", "fan"] })
      .mockRejectedValueOnce(new Error("offline"));
    await render();
    await act(async () => {
      await Promise.all([
        shown.home.add("plug").catch(() => undefined),
        shown.home.add("fan"),
      ]);
    });
    expect(shown.home.devices).toEqual(["lamp", "fan"]);
  });
});

describe("useCurrentDashboard", () => {
  let current: ReturnType<typeof useCurrentDashboard>;

  function Current(props: { dashboards?: DashboardInfo[] }) {
    current = useCurrentDashboard(props.dashboards);
    return null;
  }

  async function show(dashboards?: DashboardInfo[]) {
    await act(async () => root.render(<Current dashboards={dashboards} />));
  }

  it("shows none until the dashboards are read, then the first", async () => {
    await show();
    expect(current.current).toBeUndefined();
    await show([home, kitchen]);
    expect(current.current).toBe(home);
  });

  it("remembers the one it shows for the next start", async () => {
    await show([home, kitchen]);
    await act(async () => current.show(kitchen.id));
    expect(current.current).toBe(kitchen);

    act(() => root.unmount());
    root = createRoot(container);
    await show([home, kitchen]);
    expect(current.current).toBe(kitchen);
  });

  it("keeps it in a browser apart from the stored host", async () => {
    localStorage.setItem("sanctum.host", "{}");
    await show([home, kitchen]);
    await act(async () => current.show(kitchen.id));

    expect(localStorage.getItem("sanctum.preference.dashboard")).toBe(
      kitchen.id,
    );
    // Not even a preference named host replaces it.
    await getShell().preferences.set("host", "other");
    expect(localStorage.getItem("sanctum.host")).toBe("{}");
  });

  it("falls back to the first while the one it showed is gone", async () => {
    localStorage.setItem("sanctum.preference.dashboard", "removed");
    await show([home, kitchen]);
    expect(current.current).toBe(home);

    await act(async () => current.show(kitchen.id));
    await show([home]);
    expect(current.current).toBe(home);
  });

  it("keeps the first on show when another client moves it", async () => {
    await show([home, kitchen]);
    await show([kitchen, home]);
    expect(current.current).toBe(home);
  });

  it("still switches where it cannot remember", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    await show([home, kitchen]);
    await act(async () => current.show(kitchen.id));
    expect(current.current).toBe(kitchen);
  });

  describe("in a native shell", () => {
    // The desktop app keeps it in its data folder, since the page's own
    // storage goes with its session.
    function stubShell(get: Shell["preferences"]["get"]) {
      const preferences = { get: vi.fn(get), set: vi.fn(async () => {}) };
      vi.stubGlobal("sanctumShell", { preferences } as Partial<Shell>);
      return preferences;
    }

    it("keeps it with the shell", async () => {
      const preferences = stubShell(async () => kitchen.id);

      await show([home, kitchen]);
      expect(current.current).toBe(kitchen);
      await act(async () => current.show(home.id));

      expect(preferences.get).toHaveBeenCalledWith("dashboard");
      expect(preferences.set).toHaveBeenCalledWith("dashboard", home.id);
      expect(localStorage.length).toBe(0);
    });

    it("waits for the one it showed before falling back to the first", async () => {
      const read = deferred<string | null>();
      const preferences = stubShell(() => read.promise);

      await show([home, kitchen]);
      expect(current.current).toBeUndefined();
      await act(async () => read.resolve(kitchen.id));

      expect(current.current).toBe(kitchen);
      expect(preferences.set).not.toHaveBeenCalled();
    });

    it("keeps one chosen while it reads", async () => {
      const read = deferred<string | null>();
      stubShell(() => read.promise);

      await show([home, kitchen]);
      await act(async () => current.show(kitchen.id));
      await act(async () => read.resolve(home.id));

      expect(current.current).toBe(kitchen);
    });

    it("shows the first where the shell cannot read it", async () => {
      // As on a page being replaced, which may no longer use the bridge.
      const preferences = stubShell(async () => {
        throw new Error("Not the client");
      });
      preferences.set.mockRejectedValue(new Error("Not the client"));

      await show([home, kitchen]);
      expect(current.current).toBe(home);
      await act(async () => current.show(kitchen.id));
      expect(current.current).toBe(kitchen);
    });
  });
});
