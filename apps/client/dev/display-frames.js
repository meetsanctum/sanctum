// Frame and input timings on a wall display, posted to the dev server as
// JSON lines (dev/display.ts): how often frames come and how late, long
// animation frames and what ran in them, how long input waits to be handled,
// and how often a moving finger reports. It follows the dev server's
// control: the page to show, the run's label, blur or masks turned off, and
// what to do now, shown in a banner at the top while a run needs a hand.
// It says what the screen shows, in its first words, when that changes, so
// a run is known to be of the screen it meant to time.
// Its own cost is a callback each frame and a request every two seconds.

const kind = location.pathname.startsWith("/__display/built")
  ? "built"
  : location.pathname.startsWith("/__display/blank")
    ? "blank"
    : "dev";
const pathOf = {
  dev: "/",
  built: "/__display/built/",
  blank: "/__display/blank",
};
const load = Math.random().toString(36).slice(2, 10);

let control = { label: "", blur: true, masks: true, prompt: "", reload: 0 };
let seenReload;
let batch = { frames: [], moves: [], events: [], loafs: [] };

function percentile(sorted, share) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

function summarise(intervals) {
  const sorted = [...intervals].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: Math.round(percentile(sorted, 0.5)),
    p95: Math.round(percentile(sorted, 0.95)),
    max: Math.round(sorted.at(-1) ?? 0),
  };
}

function describe(element) {
  if (!(element instanceof Element)) return "";
  const slot = element.closest("[data-slot]")?.getAttribute("data-slot");
  const label = element.closest("[aria-label]")?.getAttribute("aria-label");
  return [element.tagName, slot, label].filter(Boolean).join(" ");
}

// Frames: the gaps between animation frames, summed up each second.
let frameGaps = [];
let lastFrame;
let frameWindow = performance.now();
function onFrame(now) {
  if (lastFrame !== undefined) frameGaps.push(now - lastFrame);
  lastFrame = now;
  if (now - frameWindow >= 1000) {
    const summary = summarise(frameGaps);
    batch.frames.push({
      at: Math.round(frameWindow),
      ...summary,
      over50: frameGaps.filter((gap) => gap > 50).length,
      over100: frameGaps.filter((gap) => gap > 100).length,
    });
    frameGaps = [];
    frameWindow = now;
  }
  requestAnimationFrame(onFrame);
}
requestAnimationFrame(onFrame);

// A moving finger: how often its moves arrive, and how many each carries.
let moveGaps = [];
let coalesced = 0;
let lastMove;
let moveWindow;
document.addEventListener(
  "pointermove",
  (event) => {
    if (event.pointerType !== "touch") return;
    const now = event.timeStamp;
    if (lastMove !== undefined && now - lastMove < 500) {
      moveGaps.push(now - lastMove);
    }
    lastMove = now;
    moveWindow ??= now;
    coalesced += event.getCoalescedEvents?.().length ?? 1;
    if (now - moveWindow >= 1000) {
      batch.moves.push({
        at: Math.round(moveWindow),
        ...summarise(moveGaps),
        coalesced,
      });
      moveGaps = [];
      coalesced = 0;
      moveWindow = now;
    }
  },
  { capture: true, passive: true },
);

function observe(type, onEntry, options = {}) {
  if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
  new PerformanceObserver((list) => list.getEntries().forEach(onEntry)).observe(
    { type, buffered: true, ...options },
  );
}

// Input that took a frame or more: how long it waited, ran and took to show.
observe(
  "event",
  (entry) =>
    batch.events.push({
      name: entry.name,
      at: Math.round(entry.startTime),
      delay: Math.round(entry.processingStart - entry.startTime),
      processing: Math.round(entry.processingEnd - entry.processingStart),
      duration: Math.round(entry.duration),
      interaction: entry.interactionId || undefined,
      target: describe(entry.target),
    }),
  { durationThreshold: 16 },
);

// Frames that took over 50 ms: how long they blocked, how much was style,
// layout and paint, and the scripts that ran longest in them.
observe("long-animation-frame", (entry) => {
  const end = entry.startTime + entry.duration;
  batch.loafs.push({
    at: Math.round(entry.startTime),
    duration: Math.round(entry.duration),
    blocking: Math.round(entry.blockingDuration),
    render: entry.renderStart ? Math.round(end - entry.renderStart) : 0,
    styleLayout: entry.styleAndLayoutStart
      ? Math.round(end - entry.styleAndLayoutStart)
      : 0,
    scripts: [...entry.scripts]
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 3)
      .map((script) => ({
        duration: Math.round(script.duration),
        invoker: script.invoker,
        source: `${script.sourceURL.split("/").at(-1)?.split("?")[0] ?? ""}${
          script.sourceFunctionName ? ` ${script.sourceFunctionName}` : ""
        }`,
      })),
  });
});

let sentScreen = false;
let shown = "";
function send(keepalive = false) {
  const { frames, moves, events, loafs } = batch;
  const shows = (document.querySelector("main") ?? document.body)?.innerText
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  const changed = shows !== undefined && shows !== shown;
  if (
    !changed &&
    !frames.length &&
    !moves.length &&
    !events.length &&
    !loafs.length
  ) {
    return;
  }
  batch = { frames: [], moves: [], events: [], loafs: [] };
  const body = {
    at: new Date().toISOString(),
    load,
    page: kind,
    label: control.label,
    blur: control.blur,
    masks: control.masks,
    frames,
    moves,
    events,
    loafs,
  };
  if (changed) {
    shown = shows;
    body.shows = shows;
  }
  if (!sentScreen) {
    sentScreen = true;
    body.screen = {
      width: innerWidth,
      height: innerHeight,
      ratio: devicePixelRatio,
      agent: navigator.userAgent,
      cores: navigator.hardwareConcurrency,
      memory: navigator.deviceMemory,
    };
  }
  fetch("/__display/frames", {
    method: "POST",
    body: JSON.stringify(body),
    keepalive,
  }).catch(() => {});
}

const styles = {
  blur: "*,*::before,*::after{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}",
  masks:
    "*,*::before,*::after{-webkit-mask-image:none!important;mask-image:none!important}",
};
function turnOff(effect, off) {
  const id = `display-frames-no-${effect}`;
  const style = document.getElementById(id);
  if (off && !style) {
    const element = document.createElement("style");
    element.id = id;
    element.textContent = styles[effect];
    document.head.append(element);
  } else if (!off && style) style.remove();
}

function showPrompt(text) {
  let banner = document.getElementById("display-frames-prompt");
  if (!text) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "display-frames-prompt";
    banner.style.cssText =
      "position:fixed;z-index:2147483647;top:8px;left:50%;transform:translateX(-50%);padding:6px 14px;border-radius:9px;background:#3e6ae1;color:#fff;font:600 15px Inter,system-ui,sans-serif;pointer-events:none";
    document.body.append(banner);
  }
  if (banner.textContent !== text) banner.textContent = text;
}

async function follow() {
  try {
    const response = await fetch("/__display/control", { cache: "no-store" });
    if (!response.ok) return;
    const next = await response.json();
    if (next.label !== control.label) send();
    control = next;
    turnOff("blur", !control.blur);
    turnOff("masks", !control.masks);
    showPrompt(control.prompt);
    if (pathOf[kind] !== control.path) {
      send(true);
      location.assign(control.path);
      return;
    }
    if (seenReload !== undefined && control.reload > seenReload) {
      send(true);
      location.reload();
      return;
    }
    seenReload = control.reload;
  } catch {
    // The dev server restarts now and then; the next look tries again.
  }
}

void follow();
setInterval(() => {
  send();
  void follow();
}, 2000);
addEventListener("pagehide", () => send(true));
