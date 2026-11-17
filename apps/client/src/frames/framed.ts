// Which apps' pages the shell shows in frames, loaded from the core, rather
// than the pages it bundles: every official app's pages and ESPHome's
// device page, on a client whose storage has `sanctum.framePages` set to
// `on`. Moods' Presses device page, which captures presses, and every page
// on any other client, are the bundled ones.

const framable: ReadonlySet<string> = new Set([
  "sanctum.weather",
  "sanctum.natural-light",
  "sanctum.zigbee",
  "sanctum.moods",
]);
const framableDevicePages: ReadonlySet<string> = new Set(["esphome.device"]);
const switchKey = "sanctum.framePages";

/** Whether this client shows an app's pages in frames. */
export function isFramed(appId: string) {
  return framable.has(appId) && isOn();
}

/** Whether this client shows one of the device pages apps add in a frame. */
export function isDevicePageFramed(pageId: string) {
  return framableDevicePages.has(pageId) && isOn();
}

function isOn() {
  try {
    return localStorage.getItem(switchKey) === "on";
  } catch {
    // Storage that can't be read, as in a private window, leaves it off.
    return false;
  }
}
