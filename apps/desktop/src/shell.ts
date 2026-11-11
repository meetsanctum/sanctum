// The bridge the client gets as `window.sanctumShell`. These shapes match
// `Shell` in apps/client/src/shell.ts, which the client is written against.

export type FoundHost = {
  id: string;
  homeId: string | null;
  name: string;
  claimed: boolean;
  url: string;
};

export type StoredHost = {
  hostId: string;
  homeId: string;
  name: string;
  url: string;
  clientId: string;
  token: string;
  kind: "personal" | "shared";
  // The host CA's pin; none over plain HTTP, in development only.
  pin: string | null;
};

// What the main process keeps: the host and the CA certificate it pinned,
// with the token. The page never needs the certificate.
export type KeptHost = StoredHost & { caCertificate: string | null };

// Why a connection to a host failed its certificate check: another CA
// answered, or the host's own certificate, but not valid now, as when a clock
// is wrong.
export type TrustFailure = "changed" | "invalid";

export const channels = {
  deviceName: "shell:device-name",
  watchHosts: "discovery:watch",
  unwatchHosts: "discovery:unwatch",
  hosts: "discovery:hosts",
  isSecure: "credentials:is-secure",
  load: "credentials:load",
  save: "credentials:save",
  forget: "credentials:forget",
  trustCheck: "trust:check",
  trustCandidate: "trust:candidate",
  trustFailure: "trust:failure",
  trustResumed: "trust:resumed",
  preferenceGet: "preferences:get",
  preferenceSet: "preferences:set",
  windowControls: "window:controls",
  sidebar: "window:sidebar",
  toggleSidebar: "window:toggle-sidebar",
} as const;

// Whether the page has a sidebar and shows it, for the View menu's item:
// none on the screens before the home.
export type SidebarState = "shown" | "hidden" | null;
