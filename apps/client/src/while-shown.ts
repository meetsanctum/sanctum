// What asks the core again and again does so only while the window is shown:
// a window behind others, minimised or on a tablet whose screen is off asks
// nothing, and once it is shown again it asks at once, so what it shows is
// fresh. Clocks that only redraw "12 min ago" keep going, since they ask
// nothing and must be right the moment the window is seen. A chart's minute,
// which redraws the whole chart, waits while hidden instead: it runs at once
// when the window is shown again.

/** Whether the window is shown now. */
export const isShown = () =>
  typeof document === "undefined" || document.visibilityState !== "hidden";

/** Calls `shown` when the window is shown again and `hidden` when it hides. */
export function onShown(shown: () => void, hidden?: () => void) {
  if (typeof document === "undefined") return () => {};
  const changed = () => {
    if (isShown()) shown();
    else hidden?.();
  };
  document.addEventListener("visibilitychange", changed);
  return () => document.removeEventListener("visibilitychange", changed);
}

/**
 * Calls `run` every `ms` while the window is shown, and at once when it is
 * shown again after a while hidden; returns a stop.
 */
export function everyWhileShown(ms: number, run: () => void) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    if (timer === undefined && isShown()) timer = setInterval(run, ms);
  };
  const pause = () => {
    clearInterval(timer);
    timer = undefined;
  };
  start();
  const changed = () => {
    if (!isShown()) {
      pause();
      return;
    }
    if (timer === undefined) {
      run();
      start();
    }
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", changed);
  }
  return () => {
    pause();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", changed);
    }
  };
}
