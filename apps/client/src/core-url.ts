// The core is a separate server. The client may be served by the core, by the
// Vite dev server (which proxies /api to the core) or from the desktop app's
// own origin (Electron), so every core request resolves against
// coreBaseUrl() instead of assuming the page's origin.

// The host this client talks to, once it has chosen one: the stored host's
// last known address, or the host being set up or signed in to.
let hostUrl: string | null = null;

export function setCoreBaseUrl(url: string | null) {
  hostUrl = url;
}

export function coreBaseUrl(): string {
  return hostUrl ?? (import.meta.env.VITE_SANCTUM_CORE_URL || location.origin);
}

export function coreUrl(path: string): string {
  return new URL(path, coreBaseUrl()).href;
}
