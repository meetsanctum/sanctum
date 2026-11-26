import type { DrawingSwitches } from "@meetsanctum/auth-protocol";

// Reduce effects and Reduce motion: this device draws the same screens more
// plainly, without live blur where the screen says data-effects="reduced" on
// <html>, and without movement where it says data-motion="reduced"
// (packages/ui-sdk/src/theme.css). They change how a screen is drawn, never
// what it shows or does, like Day and Evening.
//
// Each is on or off for this client, on its own, set on any client
// (Settings → Clients), and off until it is turned on: nothing else turns
// either on. Development and display benchmark builds can use `?effects=`
// and `?motion=` in the page's address to see either look on any device.

const off: DrawingSwitches = { reduceEffects: false, reduceMotion: false };

// "reduced" or "regular", as the page's address asks, else as it is set.
function drawn(asked: string | null | undefined, on: boolean) {
  if (asked === "reduced" || asked === "regular") return asked;
  return on ? "reduced" : "regular";
}

let chosen = off;
let applyAll = () => {};

/**
 * Says on <html> how this device draws effects and motion, and keeps it
 * current as its settings change. Called before the first render, so no
 * frame is drawn with the other look.
 */
export function followEffects(
  win: Window = window,
  allowAddressOverrides = false,
) {
  const apply = () => {
    const query = allowAddressOverrides
      ? new URLSearchParams(win.location.search)
      : undefined;
    const { dataset } = win.document.documentElement;
    const on = { effects: chosen.reduceEffects, motion: chosen.reduceMotion };
    for (const name of ["effects", "motion"] as const) {
      if (drawn(query?.get(name), on[name]) === "reduced") {
        dataset[name] = "reduced";
      } else {
        delete dataset[name];
      }
    }
  };
  applyAll = apply;
  apply();
  return () => {
    applyAll = () => {};
    chosen = off;
  };
}

/** Draws with these settings from now on. */
export function chooseDrawing(choices: DrawingSwitches) {
  if (
    choices.reduceEffects === chosen.reduceEffects &&
    choices.reduceMotion === chosen.reduceMotion
  ) {
    return;
  }
  chosen = choices;
  applyAll();
}
