import type { MenuItemConstructorOptions } from "electron";

import type { SidebarState } from "./shell.js";

// The menu bar on macOS, in place of Electron's, whose Help menu leads to
// Electron's site. Items name the app by `app.name` ("About Sanctum", "Quit
// Sanctum"); the labels set here are in sentence case. The About panel shows
// the version and the commit the app was built from (src/main.ts). Only an
// unpackaged app reloads and has the developer tools. View starts with Show
// sidebar or Hide sidebar, ⌃⌘S as in Apple's apps, dimmed on the screens
// before the home, which have none.
export function menuTemplate(options: {
  isPackaged: boolean;
  sidebar?: SidebarState;
  toggleSidebar?: () => void;
}): MenuItemConstructorOptions[] {
  const development: MenuItemConstructorOptions[] = options.isPackaged
    ? []
    : [
        { role: "reload" },
        { role: "forceReload", label: "Force reload" },
        { role: "toggleDevTools", label: "Developer tools" },
        { type: "separator" },
      ];
  return [
    {
      role: "appMenu",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers", label: "Hide others" },
        { role: "unhide", label: "Show all" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      role: "editMenu",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll", label: "Select all" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: options.sidebar === "shown" ? "Hide sidebar" : "Show sidebar",
          accelerator: "Ctrl+Cmd+S",
          enabled: !!options.sidebar,
          click: () => options.toggleSidebar?.(),
        },
        { type: "separator" },
        ...development,
        { role: "resetZoom", label: "Actual size" },
        { role: "zoomIn", label: "Zoom in" },
        { role: "zoomOut", label: "Zoom out" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Toggle full screen" },
      ],
    },
    {
      role: "windowMenu",
      submenu: [
        { role: "close", label: "Close window" },
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front", label: "Bring all to front" },
      ],
    },
  ];
}
