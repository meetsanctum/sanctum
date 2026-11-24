// Reduce effects: this device draws the same screens more plainly, without
// live blur, where the screen says data-effects="reduced" on <html>
// (packages/ui-sdk/src/theme.css). It changes how a screen is drawn, never
// what it shows or does, like Day and Evening.
//
// It is on for devices known to be weak and wherever the system asks for
// reduced transparency, and off elsewhere. `?effects=reduced` or
// `?effects=regular` in the page's address decides it instead, to see either
// look on any device while developing.

// Devices too weak for live blur, by what their web view says it is: the
// user agent names the hardware here, not the screen's size, so it is the
// one place the shell reads it. Shelly's wall displays say ShellyStargate.
const weakDevices = ["ShellyStargate/"];

const reducedTransparency = "(prefers-reduced-transparency: reduce)";

export type Effects = "regular" | "reduced";

/** How this device draws effects, from what it is and what its system asks. */
export function effectsOf(device: {
  userAgent: string;
  reducedTransparency: boolean;
  search: string;
}): Effects {
  const asked = new URLSearchParams(device.search).get("effects");
  if (asked === "reduced" || asked === "regular") return asked;
  return weakDevices.some((name) => device.userAgent.includes(name)) ||
    device.reducedTransparency
    ? "reduced"
    : "regular";
}

/**
 * Says on <html> how this device draws effects, and keeps it current as the
 * system's reduced transparency changes. Called before the first render, so
 * no frame is drawn with the other look.
 */
export function followEffects(win: Window = window) {
  const query = win.matchMedia?.(reducedTransparency);
  const apply = () => {
    const effects = effectsOf({
      userAgent: win.navigator.userAgent,
      reducedTransparency: query?.matches ?? false,
      search: win.location.search,
    });
    if (effects === "reduced") {
      win.document.documentElement.dataset.effects = "reduced";
    } else {
      delete win.document.documentElement.dataset.effects;
    }
  };
  apply();
  query?.addEventListener("change", apply);
  return () => query?.removeEventListener("change", apply);
}
