import type { BrowserWindow } from "electron";

// The macOS traffic lights, which go with the client's sidebar (the
// client's src/sidebar-state.ts): they slide in and out with it, by as far
// as it moves, on its curve and in its time, since the system draws them
// and the page cannot. They sit 20 px in and centred 27 px down, as in Dia,
// on the sidebar's top row. macOS puts them back in its own corner whenever
// they are shown again, so each step sets their place.

export const trafficLights = { x: 20, y: 20 };

// The sidebar's slide: 300 ms on cubic-bezier(0.32, 0.72, 0, 1).
const slideMs = 300;
const frameMs = 1000 / 60;
const ease = cubicBezier(0.32, 0.72, 0, 1);

type Buttons = Pick<
  BrowserWindow,
  "setWindowButtonPosition" | "setWindowButtonVisibility"
>;

type Timers = {
  now: () => number;
  every: (step: () => void, ms: number) => ReturnType<typeof setInterval>;
  stop: (timer: ReturnType<typeof setInterval> | undefined) => void;
};

const realTimers: Timers = {
  now: () => Date.now(),
  every: (step, ms) => setInterval(step, ms),
  stop: (timer) => clearInterval(timer),
};

export function createWindowLights(
  window: Buttons,
  timers: Timers = realTimers,
) {
  const home = trafficLights.x;
  // Where they are now, and whether they show.
  let x = home;
  let isShown = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  const place = (at: number) =>
    window.setWindowButtonPosition({ x: Math.round(at), y: trafficLights.y });

  return {
    // Shows or hides them, sliding `by` px with the sidebar, or at once
    // where it does not slide.
    set(visible: boolean, by: number) {
      timers.stop(timer);
      if (by <= 0) {
        x = home;
        place(home);
        window.setWindowButtonVisibility(visible);
        if (visible) place(home);
        isShown = visible;
        return;
      }
      const from = visible && !isShown ? home - by : x;
      const to = visible ? home : home - by;
      if (visible && !isShown) {
        place(from);
        window.setWindowButtonVisibility(true);
        place(from);
        isShown = true;
      }
      const start = timers.now();
      timer = timers.every(() => {
        const done = Math.min(1, (timers.now() - start) / slideMs);
        x = from + (to - from) * ease(done);
        place(x);
        if (done < 1) return;
        timers.stop(timer);
        if (!visible) {
          window.setWindowButtonVisibility(false);
          isShown = false;
          x = home;
          place(home);
        }
      }, frameMs);
    },

    stop() {
      timers.stop(timer);
    },
  };
}

export type WindowLights = ReturnType<typeof createWindowLights>;

// CSS's cubic-bezier(): the curve's x is found by bisection, which never
// fails on a curve whose x only grows.
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (t: number, p1: number, p2: number) =>
    3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t;
  return (progress: number) => {
    let low = 0;
    let high = 1;
    let t = progress;
    for (let step = 0; step < 24; step += 1) {
      t = (low + high) / 2;
      if (at(t, x1, x2) < progress) low = t;
      else high = t;
    }
    return at(t, y1, y2);
  };
}
