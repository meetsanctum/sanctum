import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import { menuTemplate } from "../src/menu.js";

function items(template: MenuItemConstructorOptions[]) {
  return template.flatMap((menu) =>
    Array.isArray(menu.submenu) ? menu.submenu : [],
  );
}

describe("menuTemplate", () => {
  it.each([true, false])(
    "keeps window closing and page zoom available (packaged: %s)",
    (isPackaged) => {
      const menus = menuTemplate({ isPackaged });
      const windowMenu = menus.find((menu) => menu.role === "windowMenu")!;
      const viewMenu = menus.find((menu) => menu.label === "View")!;
      expect(items([windowMenu]).map((item) => item.role)).toContain("close");
      expect(items([viewMenu]).map((item) => item.role)).toEqual(
        expect.arrayContaining(["resetZoom", "zoomIn", "zoomOut"]),
      );
    },
  );

  it("leaves reloading and the developer tools out of a packaged app", () => {
    const roles = items(menuTemplate({ isPackaged: true })).map(
      (item) => item.role,
    );
    expect(roles).not.toContain("reload");
    expect(roles).not.toContain("forceReload");
    expect(roles).not.toContain("toggleDevTools");
    expect(roles).toContain("togglefullscreen");
  });

  it("keeps them in an unpackaged app", () => {
    const roles = items(menuTemplate({ isPackaged: false })).map(
      (item) => item.role,
    );
    expect(roles).toEqual(
      expect.arrayContaining(["reload", "forceReload", "toggleDevTools"]),
    );
  });

  it("starts View with the sidebar's item, ⌃⌘S, named for what it does", () => {
    const toggleSidebar = vi.fn();
    const first = (sidebar?: "shown" | "hidden" | null) =>
      items([
        menuTemplate({ isPackaged: true, sidebar, toggleSidebar }).find(
          (menu) => menu.label === "View",
        )!,
      ])[0]!;
    expect(first("shown")).toMatchObject({
      label: "Hide sidebar",
      accelerator: "Ctrl+Cmd+S",
      enabled: true,
    });
    expect(first("hidden")).toMatchObject({
      label: "Show sidebar",
      enabled: true,
    });
    // The screens before the home have none: dimmed, not hidden.
    expect(first(null)).toMatchObject({
      label: "Show sidebar",
      enabled: false,
    });
    expect(first(undefined).enabled).toBe(false);
    (first("shown").click as () => void)();
    expect(toggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("has no Help menu leading to Electron's site", () => {
    const menus = menuTemplate({ isPackaged: true });
    expect(menus.map((menu) => menu.role ?? menu.label)).toEqual([
      "appMenu",
      "editMenu",
      "View",
      "windowMenu",
    ]);
  });

  it("sets its labels in sentence case", () => {
    for (const item of items(menuTemplate({ isPackaged: false }))) {
      if (item.label) {
        expect(item.label.slice(1)).toBe(item.label.slice(1).toLowerCase());
      }
    }
  });
});
