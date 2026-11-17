// Which apps' pages the shell shows in frames, loaded from the core, rather
// than the pages it bundles: Weather's, Natural light's and Zigbee's, on a
// client whose storage has `sanctum.framePages` set to `on`. Every other
// app's pages, and these on any other client, are the bundled ones.

const framable: ReadonlySet<string> = new Set([
  "sanctum.weather",
  "sanctum.natural-light",
  "sanctum.zigbee",
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
