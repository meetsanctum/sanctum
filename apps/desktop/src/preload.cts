// The narrow bridge the client gets as `window.sanctumShell` (Shell in
// apps/client/src/shell.ts). Tokens and preferences are kept, discovery
// runs and every connection's certificate is checked in the main process.
// A sandboxed preload cannot load other files, so the channel names repeat
// `channels` in shell.ts.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { FoundHost, StoredHost } from "./shell.js";

contextBridge.exposeInMainWorld("sanctumShell", {
  platform:
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : "linux",
  deviceName: () => ipcRenderer.invoke("shell:device-name"),
  discovery: {
    watch(onHosts: (hosts: FoundHost[]) => void) {
      const listener = (_event: IpcRendererEvent, hosts: FoundHost[]) =>
        onHosts(hosts);
      ipcRenderer.on("discovery:hosts", listener);
      ipcRenderer.send("discovery:watch");
      return () => {
        ipcRenderer.off("discovery:hosts", listener);
        ipcRenderer.send("discovery:unwatch");
      };
    },
  },
  credentials: {
    isSecure: () => ipcRenderer.invoke("credentials:is-secure"),
    load: () => ipcRenderer.invoke("credentials:load"),
    save: (host: StoredHost) => ipcRenderer.invoke("credentials:save", host),
    forget: (token: string, resume?: unknown) =>
      ipcRenderer.invoke("credentials:forget", token, resume),
  },
  trust: {
    check: (hostId: string | null, resume?: unknown) =>
      ipcRenderer.invoke("trust:check", hostId, resume),
    candidate: () => ipcRenderer.invoke("trust:candidate"),
    failure: (url: string) => ipcRenderer.invoke("trust:failure", url),
    resumed: () => ipcRenderer.invoke("trust:resumed"),
  },
  preferences: {
    get: (key: string) => ipcRenderer.invoke("preferences:get", key),
    set: (key: string, value: string) =>
      ipcRenderer.invoke("preferences:set", key, value),
  },
  window: {
    setControls: (visible: boolean, by = 0) =>
      ipcRenderer.invoke("window:controls", visible, by),
    setSidebar: (state: "shown" | "hidden" | null) =>
      ipcRenderer.invoke("window:sidebar", state),
    onToggleSidebar(listener: () => void) {
      const toggle = () => listener();
      ipcRenderer.on("window:toggle-sidebar", toggle);
      return () => {
        ipcRenderer.off("window:toggle-sidebar", toggle);
      };
    },
  },
});
