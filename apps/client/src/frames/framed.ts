// Which apps' pages the shell shows in frames, loaded from the core, rather
// than the pages it bundles: every official app's, on a client whose
// storage has `sanctum.framePages` set to `on`. Their device pages, and
// every page on any other client, are the bundled ones.

const framable: ReadonlySet<string> = new Set([
  "sanctum.weather",
  "sanctum.natural-light",
  "sanctum.zigbee",
  "sanctum.moods",
]);
const switchKey = "sanctum.framePages";

/** Whether this client shows an app's pages in frames. */
export function isFramed(appId: string) {
  if (!framable.has(appId)) return false;
  try {
    return localStorage.getItem(switchKey) === "on";
  } catch {
    // Storage that can't be read, as in a private window, leaves it off.
    return false;
  }
}
