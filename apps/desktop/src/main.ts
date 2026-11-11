import {
  app,
  ipcMain,
  Menu,
  protocol,
  safeStorage,
  session,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents,
} from "electron";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { clientScheme, isClientUrl } from "./client-files.js";
import { createCredentialStore, safeStorageCipher } from "./credentials.js";
import { deviceName } from "./device-name.js";
import { watchHosts, watchDevHost } from "./discovery.js";
import { menuTemplate } from "./menu.js";
import {
  channels,
  type FoundHost,
  type KeptHost,
  type SidebarState,
  type StoredHost,
} from "./shell.js";
import { createPages, type Pages } from "./pages.js";
import { createPreferenceStore } from "./preferences.js";
import { createHostTrust, type HostTrust } from "./trust.js";

// The desktop app: a window on the client, loaded from the app's own origin.
// Like every client it talks only to the core. It browses for hosts, keeps
// the client token and preferences here, out of the page, and checks every
// connection the page makes against the host's pin.

const here = dirname(fileURLToPath(import.meta.url));
// The built client: beside the main process in a packaged app
// (scripts/package.ts), else the client package's build.
const clientRoot = app.isPackaged
  ? join(here, "client")
  : join(
      dirname(
        createRequire(import.meta.url).resolve(
          "@meetsanctum/client/package.json",
        ),
      ),
      "dist",
    );

// A standard, secure scheme: the page gets an origin of its own and the
// WebCrypto it signs in with.
protocol.registerSchemesAsPrivileged([
  {
    scheme: clientScheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let pages: Pages | undefined;

// Only the client's own page may use the bridge, in the current window.
function fromClient(event: IpcMainEvent | IpcMainInvokeEvent) {
  return (
    isClientUrl(event.senderFrame?.url ?? "") &&
    pages?.isCurrent(event.sender) === true
  );
}

function handle<T>(
  channel: string,
  listener: (...args: never[]) => T | Promise<T>,
) {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!fromClient(event)) {
      throw new Error("Not the client");
    }
    return (listener as (...args: unknown[]) => T | Promise<T>)(...args);
  });
}

// One browser for every page that is looking for hosts.
function serveDiscovery(
  devHostUrl: string | undefined,
  fetchStatus: typeof fetch,
) {
  const watchers = new Map<WebContents, number>();
  let found: FoundHost[] = [];
  let devHost: FoundHost | undefined;
  let stop: (() => void) | undefined;

  const hosts = () =>
    devHost
      ? [devHost, ...found.filter((host) => host.id !== devHost!.id)]
      : found;
  const publish = () => {
    for (const contents of watchers.keys()) {
      contents.send(channels.hosts, hosts());
    }
  };
  const start = () => {
    const stopBrowsing = watchHosts((next) => {
      found = next;
      publish();
    });
    const stopDevHost = devHostUrl
      ? watchDevHost(
          devHostUrl,
          (host) => {
            devHost = host;
            publish();
          },
          fetchStatus,
        )
      : undefined;
    return () => {
      stopBrowsing();
      stopDevHost?.();
    };
  };
  const release = (contents: WebContents, all = false) => {
    const count = (watchers.get(contents) ?? 0) - 1;
    if (count > 0 && !all) {
      watchers.set(contents, count);
    } else {
      watchers.delete(contents);
    }
    if (watchers.size === 0) {
      stop?.();
      stop = undefined;
      found = [];
      devHost = undefined;
    }
  };

  ipcMain.on(channels.watchHosts, (event) => {
    if (!fromClient(event)) {
      return;
    }
    const contents = event.sender;
    if (!watchers.has(contents)) {
      contents.once("destroyed", () => release(contents, true));
    }
    watchers.set(contents, (watchers.get(contents) ?? 0) + 1);
    stop ??= start();
    contents.send(channels.hosts, hosts());
  });
  ipcMain.on(channels.unwatchHosts, (event) => {
    if (fromClient(event)) {
      release(event.sender);
    }
  });
}

function lockDown(sessions: Session[]) {
  // The client asks for no permissions: no camera, notifications or the like.
  for (const each of sessions) {
    each.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    each.setPermissionCheckHandler(() => false);
  }
}

// Register once for the app, not once per replacement page session.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!isClientUrl(url)) {
      event.preventDefault();
    }
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

// The stored host as the page sees it: without the CA certificate.
function forPage(host: KeptHost | null): StoredHost | null {
  if (!host) {
    return null;
  }
  const { caCertificate: _certificate, ...stored } = host;
  return stored;
}

// The menu bar, built again whenever the page's sidebar changes, so View
// says Show sidebar or Hide sidebar (menu.ts).
let sidebar: SidebarState = null;
function setMenu() {
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        menuTemplate({
          isPackaged: app.isPackaged,
          sidebar,
          toggleSidebar: () => pages?.toggleSidebar(),
        }),
      ),
    );
  }
}

void app.whenReady().then(async () => {
  setMenu();
  // A packaged app knows the commit it was built from (scripts/package.ts),
  // which the About panel shows after the version.
  if (process.env.SANCTUM_BUILD) {
    app.setAboutPanelOptions({ version: process.env.SANCTUM_BUILD });
  }
  // Plain HTTP only in development, against `pnpm dev`.
  const allowPlainHttp = !app.isPackaged;
  // The development host's status, a hint like an announcement.
  const hints = session.fromPartition("sanctum-discovery");
  hints.setCertificateVerifyProc((_request, callback) => callback(0));
  lockDown([session.defaultSession, hints]);

  const credentials = createCredentialStore(
    join(app.getPath("userData"), "host.json"),
    safeStorageCipher(safeStorage),
    { allowPlainHttp },
  );
  const preferences = createPreferenceStore(
    join(app.getPath("userData"), "preferences.json"),
  );
  const trust: HostTrust = createHostTrust({ credentials });
  await trust.start();
  const shown = createPages({
    clientRoot,
    preload: join(here, "preload.cjs"),
    allowPlainHttp,
    trust: () => trust,
    lockDown: (own) => lockDown([own]),
  });
  pages = shown;
  handle(channels.deviceName, deviceName);
  handle(channels.isSecure, () => credentials.isSecure());
  handle(channels.load, async () => forPage(await credentials.load()));
  handle(channels.save, (host: StoredHost) => trust.save(host));
  handle(channels.forget, async (token: string, resume: unknown) => {
    if (await trust.forget(String(token))) {
      await shown.refresh(resume ?? null);
    }
  });
  // A change of trust moves the page to a fresh session (pages.ts), which
  // comes back to the view the page asked for.
  handle(
    channels.trustCheck,
    async (hostId: string | null, resume: unknown) => {
      if (trust.check(hostId === null ? null : String(hostId))) {
        await shown.refresh(resume ?? null);
      }
    },
  );
  handle(channels.trustResumed, () => shown.resumed());
  handle(channels.trustCandidate, () => trust.candidate());
  handle(channels.trustFailure, (url: string) => trust.failure(String(url)));
  handle(channels.preferenceGet, (key: string) => preferences.get(String(key)));
  handle(channels.preferenceSet, (key: string, value: string) =>
    preferences.set(key, value),
  );
  // A slide no further than the window's edge from where they sit.
  handle(channels.windowControls, (visible: boolean, by: number) =>
    shown.setWindowControls(
      visible === true,
      typeof by === "number" && Number.isFinite(by)
        ? Math.max(0, Math.min(400, by))
        : 0,
    ),
  );
  handle(channels.sidebar, (state: SidebarState) => {
    const next = state === "shown" || state === "hidden" ? state : null;
    if (next !== sidebar) {
      sidebar = next;
      setMenu();
    }
  });
  serveDiscovery(
    allowPlainHttp ? process.env.SANCTUM_DEV_HOST_URL || undefined : undefined,
    (input, init) => hints.fetch(String(input), init),
  );

  shown.open();
  app.on("activate", () => {
    if (!shown.hasWindow()) {
      shown.open();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
