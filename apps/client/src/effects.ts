import type { DrawingChoice, Drawn } from "@meetsanctum/auth-protocol";

// Reduce effects and Reduce motion: this device draws the same screens more
// plainly, without live blur where the screen says data-effects="reduced" on
// <html>, and without movement where it says data-motion="reduced"
// (packages/ui-sdk/src/theme.css). They change how a screen is drawn, never
// what it shows or does, like Day and Evening.
//
// Each is chosen for this client on any client, Automatic, On or Off
// (Settings → Clients). Automatic turns each on for devices known to be
// slow, Reduce effects wherever the system asks for reduced transparency and
// Reduce motion wherever it asks for reduced motion, and leaves it off
// elsewhere. `?effects=` and `?motion=` in the page's address, `reduced` or
// `regular`, decide them instead, to see either look on any device while
// developing.

// Devices too weak for live blur and movement, by what their web view says
// it is: the user agent names the hardware here, not the screen's size, so
// it is the one place the shell reads it. Shelly's wall displays say
// ShellyStargate.
const weakDevices = ["ShellyStargate/"];

export type Effects = "regular" | "reduced";
export type Motion = "regular" | "reduced";

/** Reduce effects and Reduce motion as chosen for this client. */
export type DrawingChoices = { effects: DrawingChoice; motion: DrawingChoice };

const automatic: DrawingChoices = { effects: "automatic", motion: "automatic" };

type Device = { userAgent: string; search: string };

const isSlow = (device: Device) =>
  weakDevices.some((weak) => device.userAgent.includes(weak));

function resolve(
  device: Device,
  name: "effects" | "motion",
  choice: DrawingChoice,
  systemAsks: boolean,
): "regular" | "reduced" {
  const asked = new URLSearchParams(device.search).get(name);
  if (asked === "reduced" || asked === "regular") return asked;
  if (choice === "on") return "reduced";
  if (choice === "off") return "regular";
  return isSlow(device) || systemAsks ? "reduced" : "regular";
}

/** How this device draws effects, from its choice, what it is and what its system asks. */
export function effectsOf(
  device: Device & { reducedTransparency: boolean },
  choice: DrawingChoice = "automatic",
): Effects {
  return resolve(device, "effects", choice, device.reducedTransparency);
}

/** How this device draws motion, from its choice, what it is and what its system asks. */
export function motionOf(
  device: Device & { reducedMotion: boolean },
  choice: DrawingChoice = "automatic",
): Motion {
  return resolve(device, "motion", choice, device.reducedMotion);
}

// What this device follows: its choices, and what it said it draws with.
let chosen = automatic;
let applyAll = () => {};
let drawnNow: Drawn | undefined;
const drawnListeners = new Set<(drawn: Drawn) => void>();

/**
 * Says on <html> how this device draws effects and motion, and keeps them
 * current as its choices and the system's reduced transparency and reduced
 * motion change. Called before the first render, so no frame is drawn with
 * the other look.
 */
export function followEffects(win: Window = window) {
  const transparency = win.matchMedia?.(
    "(prefers-reduced-transparency: reduce)",
  );
  const motion = win.matchMedia?.("(prefers-reduced-motion: reduce)");
  const apply = () => {
    const device = {
      userAgent: win.navigator.userAgent,
      search: win.location.search,
    };
    const drawn: Drawn = {
      effects: effectsOf(
        { ...device, reducedTransparency: transparency?.matches ?? false },
        chosen.effects,
      ),
      motion: motionOf(
        { ...device, reducedMotion: motion?.matches ?? false },
        chosen.motion,
      ),
      slowDevice: isSlow(device),
    };
    const { dataset } = win.document.documentElement;
    for (const name of ["effects", "motion"] as const) {
      if (drawn[name] === "reduced") dataset[name] = "reduced";
      else delete dataset[name];
    }
    if (drawnNow && sameDrawn(drawnNow, drawn)) return;
    drawnNow = drawn;
    for (const listener of drawnListeners) listener(drawn);
  };
  applyAll = apply;
  apply();
  transparency?.addEventListener("change", apply);
  motion?.addEventListener("change", apply);
  return () => {
    transparency?.removeEventListener("change", apply);
    motion?.removeEventListener("change", apply);
    applyAll = () => {};
    drawnNow = undefined;
    chosen = automatic;
  };
}

/** Draws with these choices from now on. */
export function chooseDrawing(choices: DrawingChoices) {
  if (choices.effects === chosen.effects && choices.motion === chosen.motion) {
    return;
  }
  chosen = choices;
  applyAll();
}

/** What this device draws with now, and each time that changes. */
export function followDrawn(listener: (drawn: Drawn) => void) {
  drawnListeners.add(listener);
  if (drawnNow) listener(drawnNow);
  return () => {
    drawnListeners.delete(listener);
  };
}

export const sameDrawn = (a: Drawn, b: Drawn) =>
  a.effects === b.effects &&
  a.motion === b.motion &&
  a.slowDevice === b.slowDevice;
