// Reduce effects and Reduce motion: this device draws the same screens more
// plainly, without live blur where the screen says data-effects="reduced" on
// <html>, and without movement where it says data-motion="reduced"
// (packages/ui-sdk/src/theme.css). They change how a screen is drawn, never
// what it shows or does, like Day and Evening.
//
// Each is on for devices known to be weak, Reduce effects wherever the
// system asks for reduced transparency and Reduce motion wherever it asks
// for reduced motion, and each is off elsewhere. `?effects=` and `?motion=`
// in the page's address, `reduced` or `regular`, decide them instead, to see
// either look on any device while developing.

// Devices too weak for live blur and movement, by what their web view says
// it is: the user agent names the hardware here, not the screen's size, so
// it is the one place the shell reads it. Shelly's wall displays say
// ShellyStargate.
const weakDevices = ["ShellyStargate/"];

export type Effects = "regular" | "reduced";
export type Motion = "regular" | "reduced";

type Device = { userAgent: string; search: string };

function resolve(
  device: Device,
  name: "effects" | "motion",
  systemAsks: boolean,
): "regular" | "reduced" {
  const asked = new URLSearchParams(device.search).get(name);
  if (asked === "reduced" || asked === "regular") return asked;
  return weakDevices.some((weak) => device.userAgent.includes(weak)) ||
    systemAsks
    ? "reduced"
    : "regular";
}

/** How this device draws effects, from what it is and what its system asks. */
export function effectsOf(
  device: Device & { reducedTransparency: boolean },
): Effects {
  return resolve(device, "effects", device.reducedTransparency);
}

/** How this device draws motion, from what it is and what its system asks. */
export function motionOf(device: Device & { reducedMotion: boolean }): Motion {
  return resolve(device, "motion", device.reducedMotion);
}

// Says on <html> how this device draws one of them, and keeps it current
// as the system's setting changes.
function follow(
  win: Window,
  attribute: "effects" | "motion",
  media: string,
  resolved: (device: Device, systemAsks: boolean) => "regular" | "reduced",
) {
  const query = win.matchMedia?.(media);
  const apply = () => {
    const device = {
      userAgent: win.navigator.userAgent,
      search: win.location.search,
    };
    const { dataset } = win.document.documentElement;
    if (resolved(device, query?.matches ?? false) === "reduced") {
      dataset[attribute] = "reduced";
    } else {
      delete dataset[attribute];
    }
  };
  apply();
  query?.addEventListener("change", apply);
  return () => query?.removeEventListener("change", apply);
}

/**
 * Says on <html> how this device draws effects and motion, and keeps them
 * current as the system's reduced transparency and reduced motion change.
 * Called before the first render, so no frame is drawn with the other look.
 */
export function followEffects(win: Window = window) {
  const stopEffects = follow(
    win,
    "effects",
    "(prefers-reduced-transparency: reduce)",
    (device, reducedTransparency) =>
      effectsOf({ ...device, reducedTransparency }),
  );
  const stopMotion = follow(
    win,
    "motion",
    "(prefers-reduced-motion: reduce)",
    (device, reducedMotion) => motionOf({ ...device, reducedMotion }),
  );
  return () => {
    stopEffects();
    stopMotion();
  };
}
