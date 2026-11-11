// @vitest-environment jsdom
import { act, type PointerEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSidebarLayout, type SidebarLayout } from "../src/sidebar-state";
import * as shell from "../src/shell";

let layout: SidebarLayout;
let root: Root;
let container: HTMLDivElement;

function Sidebar({ isVeiled = false }: { isVeiled?: boolean }) {
  layout = useSidebarLayout(isVeiled);
  return null;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: !query.includes("prefers-reduced-motion"),
    addEventListener() {},
    removeEventListener() {},
  }));
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Sidebar />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const restOnEdge = async () => {
  await act(async () => {
    layout.edge?.onPointerEnter({ pointerType: "mouse" } as PointerEvent);
  });
};

function nativeSidebar() {
  let toggle = () => {};
  const nativeWindow = {
    setControls: vi.fn(async () => {}),
    setSidebar: vi.fn(async () => {}),
    onToggleSidebar(listener: () => void) {
      toggle = listener;
      return () => {};
    },
  };
  vi.spyOn(shell, "getShell").mockReturnValue({
    ...shell.getShell(),
    window: nativeWindow,
  });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  return { ...nativeWindow, toggle: () => toggle() };
}

describe("sidebar transitions", () => {
  it("names the native command for opening or closing a narrow sidebar", async () => {
    const native = nativeSidebar();
    await act(async () => root.render(<Sidebar key="native" />));
    expect(native.setSidebar).toHaveBeenLastCalledWith("hidden");

    await act(async () => native.toggle());

    expect(layout.floating).toBe("open");
    expect(native.setSidebar).toHaveBeenLastCalledWith("shown");
    await act(async () => native.toggle());
    expect(layout.floating).toBeNull();
    expect(native.setSidebar).toHaveBeenLastCalledWith("hidden");
  });

  it("ignores the native sidebar shortcut and disables its menu under a veil", async () => {
    const native = nativeSidebar();
    await act(async () => root.render(<Sidebar key="native" />));
    expect(layout.docked).toBe(false);
    await act(async () => root.render(<Sidebar key="native" isVeiled />));

    await act(async () => native.toggle());

    expect(layout.floating).toBeNull();
    expect(native.setSidebar).toHaveBeenLastCalledWith(null);
  });

  it.each(["dock", "close"] as const)(
    "cancels a pending hover when asked to %s",
    async (action) => {
      await act(async () => layout.toggle());
      await restOnEdge();

      await act(async () => {
        if (action === "dock") layout.toggle();
        else layout.close();
      });
      await act(async () => vi.advanceTimersByTime(200));

      expect(layout.floating).toBeNull();
      expect(layout.docked).toBe(action === "dock");
    },
  );

  it("forgets a menu's hold when its floating sidebar closes", async () => {
    await act(async () => layout.toggle());
    await restOnEdge();
    await act(async () => vi.advanceTimersByTime(200));
    expect(layout.floating).toBe("peek");
    await act(async () => layout.hold(true));
    await act(async () => layout.close());
    // Let the edge's pause end, then bring it in again.
    await act(async () => vi.advanceTimersByTime(500));
    await restOnEdge();
    await act(async () => vi.advanceTimersByTime(200));

    await act(async () => {
      layout.peek.onPointerEnter();
      layout.peek.onPointerLeave();
      vi.advanceTimersByTime(300);
    });

    expect(layout.floating).toBeNull();
  });

  it.each(["collapses", "docks"] as const)(
    "slides the page while the toggle %s the sidebar",
    async (action) => {
      if (action === "docks") {
        await act(async () => layout.toggle());
        await act(async () => vi.advanceTimersByTime(350));
      }
      expect(layout.isSliding).toBe(false);

      await act(async () => layout.toggle());

      expect(layout.docked).toBe(action === "docks");
      expect(layout.isSliding).toBe(true);
      await act(async () => vi.advanceTimersByTime(349));
      expect(layout.isSliding).toBe(true);
      await act(async () => vi.advanceTimersByTime(1));
      expect(layout.isSliding).toBe(false);
    },
  );

  it("keeps sliding when the toggle turns a slide back", async () => {
    await act(async () => layout.toggle());
    await act(async () => vi.advanceTimersByTime(200));

    await act(async () => layout.toggle());
    await act(async () => vi.advanceTimersByTime(200));

    expect(layout.docked).toBe(true);
    expect(layout.isSliding).toBe(true);
    await act(async () => vi.advanceTimersByTime(150));
    expect(layout.isSliding).toBe(false);
  });

  it("slides nothing as it reads this device's choice", async () => {
    await act(async () => layout.toggle());
    await act(async () => vi.advanceTimersByTime(350));

    await act(async () => root.render(<Sidebar key="again" />));

    expect(layout.docked).toBe(false);
    expect(layout.isSliding).toBe(false);
  });

  it("slides nothing where the window is too narrow to dock", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    await act(async () => root.render(<Sidebar key="narrow" />));

    await act(async () => layout.toggle());

    expect(layout.floating).toBe("open");
    expect(layout.isSliding).toBe(false);
  });

  it.each(["collapses", "docks"] as const)(
    "ends the slide if the window narrows as the sidebar %s",
    async (action) => {
      if (action === "docks") {
        await act(async () => layout.toggle());
        await act(async () => vi.advanceTimersByTime(350));
      }
      await act(async () => layout.toggle());
      await act(async () => vi.advanceTimersByTime(80));
      expect(layout.isSliding).toBe(true);

      vi.stubGlobal("matchMedia", () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      }));
      await act(async () => root.render(<Sidebar />));

      expect(layout.docked).toBe(false);
      expect(layout.isSliding).toBe(false);

      // Widening again before the original slide ends must not resume it.
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: !query.includes("prefers-reduced-motion"),
        addEventListener() {},
        removeEventListener() {},
      }));
      await act(async () => root.render(<Sidebar />));
      expect(layout.docked).toBe(action === "docks");
      expect(layout.isSliding).toBe(false);
    },
  );

  it("slides nothing where motion is reduced", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    await act(async () => root.render(<Sidebar />));

    await act(async () => layout.toggle());
    expect(layout.docked).toBe(false);
    expect(layout.isSliding).toBe(false);
    await act(async () => layout.toggle());
    expect(layout.docked).toBe(true);
    expect(layout.isSliding).toBe(false);
  });

  it("ends the slide when motion is reduced midway", async () => {
    await act(async () => layout.toggle());
    await act(async () => vi.advanceTimersByTime(80));
    expect(layout.isSliding).toBe(true);

    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    await act(async () => root.render(<Sidebar />));

    expect(layout.isSliding).toBe(false);

    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: !query.includes("prefers-reduced-motion"),
      addEventListener() {},
      removeEventListener() {},
    }));
    await act(async () => root.render(<Sidebar />));
    expect(layout.docked).toBe(false);
    expect(layout.isSliding).toBe(false);
  });
});

describe("the traffic lights under an overlay", () => {
  // Wide enough to dock, in the desktop app.
  async function dockedInTheApp() {
    const native = nativeSidebar();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: !query.includes("prefers-reduced-motion"),
      addEventListener() {},
      removeEventListener() {},
    }));
    await act(async () => root.render(<Sidebar key="native" />));
    expect(layout.docked).toBe(true);
    native.setControls.mockClear();
    return native;
  }

  it("hides them at once as it comes, and brings them back at once", async () => {
    const native = await dockedInTheApp();

    await act(async () => layout.setCovered(true));
    expect(native.setControls.mock.calls).toEqual([[false, 0]]);

    await act(async () => layout.setCovered(false));
    expect(native.setControls.mock.calls).toEqual([
      [false, 0],
      [true, 0],
    ]);
  });

  it.each(["docked", "floating"] as const)(
    "hides them at once if an overlay opens while the %s sidebar slides out",
    async (kind) => {
      const native =
        kind === "docked" ? await dockedInTheApp() : nativeSidebar();
      if (kind === "floating") {
        await act(async () => root.render(<Sidebar key="native" />));
        await act(async () => native.toggle());
      }
      await act(async () => native.toggle());
      expect(native.setControls).toHaveBeenLastCalledWith(
        false,
        kind === "docked" ? 248 : 264,
      );
      await act(async () => vi.advanceTimersByTime(16));
      native.setControls.mockClear();

      await act(async () => layout.setCovered(true));

      expect(native.setControls.mock.calls).toEqual([[false, 0]]);
    },
  );

  it("keeps them hidden while the sidebar's shortcut collapses it behind", async () => {
    const native = await dockedInTheApp();
    await act(async () => layout.setCovered(true));
    native.setControls.mockClear();

    await act(async () => native.toggle());
    expect(layout.docked).toBe(false);
    await act(async () => layout.setCovered(false));

    // Collapsed by then, so they stay hidden.
    expect(native.setControls).not.toHaveBeenCalled();
  });

  it("brings them back at once for a sidebar docked behind it", async () => {
    const native = await dockedInTheApp();
    await act(async () => native.toggle());
    await act(async () => layout.setCovered(true));
    native.setControls.mockClear();

    await act(async () => native.toggle());
    expect(layout.docked).toBe(true);
    expect(native.setControls).not.toHaveBeenCalled();

    await act(async () => layout.setCovered(false));
    expect(native.setControls.mock.calls).toEqual([[true, 0]]);
  });

  it("still slides them with the sidebar once it has gone", async () => {
    const native = await dockedInTheApp();
    await act(async () => layout.setCovered(true));
    await act(async () => layout.setCovered(false));
    native.setControls.mockClear();

    await act(async () => native.toggle());

    expect(native.setControls.mock.calls).toEqual([[false, 248]]);
  });
});
