import type { ClientKind, Platform } from "@meetsanctum/auth-protocol";

// What the native shell around the client provides: discovery of hosts on
// the home network, secure storage for the client token, the check of every
// connection's certificate, a place for the client's preferences and the
// window around it. The Electron app exposes it as `window.sanctumShell`
// (apps/desktop/src/preload.cts); a plain browser, used only in
// development over plain HTTP, gets the fallback below.

// A host announcing itself as `_sanctum._tcp`.
export type FoundHost = {
  id: string;
  // The home it serves; none until its core has reported one.
  homeId: string | null;
  name: string;
  claimed: boolean;
  // Where its core answers, such as https://192.168.1.20:4100.
  url: string;
};

// What a paired client keeps: the host id with its token, so it only talks
// to that host and finds it again by id when its address changes, the
// home's id, so it finds the same home on another host, and the pin of its
// CA, which the shell checks every connection against.
export type StoredHost = {
  hostId: string;
  homeId: string;
  name: string;
  url: string;
  clientId: string;
  token: string;
  // How it checks the host again when the certificate changes: a personal
  // client signs in, a shared one shows a pairing code.
  kind: ClientKind;
  // None over plain HTTP, in development only.
  pin: string | null;
};

// Why a connection failed the shell's certificate check: another CA
// answered, or the host's own certificate, but not valid now, as when a clock
// is wrong.
export type TrustFailure = "changed" | "invalid";

export type Shell = {
  platform: Platform;
  deviceName(): Promise<string>;
  // None where the shell cannot browse the network.
  discovery: {
    watch(onHosts: (hosts: FoundHost[]) => void): () => void;
  } | null;
  credentials: {
    // False where the system offers no secure storage: the app warns
    // before saving the token unencrypted.
    isSecure(): Promise<boolean>;
    load(): Promise<StoredHost | null>;
    save(host: StoredHost): Promise<void>;
    // Forgets the stored host only if it still holds this token. Forgetting
    // its pin may reload the page in a fresh session, which then gets
    // `resume` back from `trust.resumed()`.
    forget(token: string, resume?: unknown): Promise<void>;
  };
  // None where nothing checks certificates: a plain browser in development,
  // over plain HTTP.
  trust: {
    // Starts checking the host with this id as a first contact: the shell
    // holds the first CA it sees as the only candidate and lets no token
    // through until a claim, sign-in or pairing saves it. Null ends it.
    // A change of trust may reload the page in a fresh session, which then
    // gets `resume` back from `resumed()`.
    check(hostId: string | null, resume?: unknown): Promise<void>;
    resumed(): Promise<unknown>;
    // The candidate's pin, once a connection has presented one.
    candidate(): Promise<string | null>;
    // Why the last connection to this address failed its check, if it did.
    failure(url: string): Promise<TrustFailure | null>;
  } | null;
  // What this client keeps about how it shows the home, such as the
  // dashboard on show, by name, where it outlives the page: the desktop app
  // keeps it in its data folder, since the page's own storage goes with its
  // session (apps/desktop/src/pages.ts), and a plain browser in
  // `localStorage`, apart from the stored host.
  preferences: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
  };
  // The window around the page, where the shell draws one: on macOS its
  // traffic lights, which go with the sidebar, and View's Show sidebar or
  // Hide sidebar, ⌃⌘S, which names what it does (apps/desktop/src/menu.ts).
  // None in a plain browser.
  window?: {
    // Slides them `by` px with the sidebar, or moves them at once.
    setControls(visible: boolean, by?: number): Promise<void>;
    // Null on the screens before the home, which have no sidebar.
    setSidebar(state: "shown" | "hidden" | null): Promise<void>;
    onToggleSidebar(listener: () => void): () => void;
  } | null;
};

declare global {
  interface Window {
    sanctumShell?: Shell;
  }
}

const storageKey = "sanctum.host";
const preferencePrefix = "sanctum.preference.";

function browserShell(): Shell {
  return {
    platform: "web",
    deviceName: async () => "Web browser",
    discovery: null,
    credentials: {
      isSecure: async () => false,
      load: async () => {
        try {
          const stored = localStorage.getItem(storageKey);
          return stored ? (JSON.parse(stored) as StoredHost) : null;
        } catch {
          return null;
        }
      },
      save: async (host) =>
        localStorage.setItem(storageKey, JSON.stringify(host)),
      forget: async (token) => {
        const stored = localStorage.getItem(storageKey);
        if (stored && (JSON.parse(stored) as StoredHost).token === token) {
          localStorage.removeItem(storageKey);
        }
      },
    },
    trust: null,
    preferences: {
      get: async (key) => {
        try {
          return localStorage.getItem(preferencePrefix + key);
        } catch {
          return null;
        }
      },
      set: async (key, value) =>
        localStorage.setItem(preferencePrefix + key, value),
    },
    window: null,
  };
}

let fallback: Shell | undefined;

export function getShell(): Shell {
  return globalThis.window?.sanctumShell ?? (fallback ??= browserShell());
}
