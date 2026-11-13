// After an update a page still running the build before it can ask for a
// chunk the new build no longer has, and the import fails. Reloading loads
// the new build. The page reloads once per build: one that comes back as the
// same build and fails again keeps the error, rather than reloading in a
// loop. The build is told by the entry chunk's address, whose name carries
// its hash, and remembered for the window's session, which a reload keeps,
// in the desktop app's session of its own too (apps/desktop/src/pages.ts).

const reloadedFrom = "sanctum.reloadedFrom";

// How each engine says a module did not load: Chromium, the desktop app's
// included, then WebKit, then Firefox.
const failedImport = [
  "Failed to fetch dynamically imported module",
  "Importing a module script failed",
  "error loading dynamically imported module",
  "Unable to preload CSS for",
];

/** Whether an error is a module that did not load. */
export function isFailedImport(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return failedImport.some((words) => message.includes(words));
}

/**
 * Reloads the page once its build fails to load a module: Vite's
 * `vite:preloadError` for the imports it wraps, and any other import the
 * page leaves unhandled, React's render errors included. Returns a way to
 * stop.
 */
export function reloadOnFailedImports(
  options: {
    build?: string;
    storage?: () => Pick<Storage, "getItem" | "setItem">;
    reload?: () => void;
    target?: Window;
  } = {},
) {
  const build = options.build ?? import.meta.url;
  const storage = options.storage ?? (() => sessionStorage);
  const reload = options.reload ?? (() => location.reload());
  const target = options.target ?? window;
  let isReloading = false;

  const recover = (event: Event) => {
    if (!isReloading) {
      // Without somewhere to remember it, the page never reloads.
      try {
        const remembered = storage();
        if (remembered.getItem(reloadedFrom) === build) return;
        remembered.setItem(reloadedFrom, build);
      } catch {
        return;
      }
      isReloading = true;
      reload();
    }
    // The page is going: what failed need not say so meanwhile.
    event.preventDefault();
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    if (isFailedImport(event.reason)) recover(event);
  };
  const onError = (event: ErrorEvent) => {
    if (isFailedImport(event.error ?? event.message)) recover(event);
  };
  // Vite reports module evaluation errors here too. Reload only when an
  // asset did not load; application errors must reach their caller.
  const onPreloadError = (event: Event) => {
    if (isFailedImport((event as Event & { payload?: unknown }).payload)) {
      recover(event);
    }
  };

  target.addEventListener("vite:preloadError", onPreloadError);
  target.addEventListener("unhandledrejection", onRejection);
  target.addEventListener("error", onError);
  return () => {
    target.removeEventListener("vite:preloadError", onPreloadError);
    target.removeEventListener("unhandledrejection", onRejection);
    target.removeEventListener("error", onError);
  };
}
