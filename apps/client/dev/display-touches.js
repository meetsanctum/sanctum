let gesture;
let finishTimer;
const pointers = new Set();

function describe(element) {
  return element instanceof Element
    ? element.tagName +
        "[" +
        (element.closest("[data-slot]")?.getAttribute("data-slot") ?? "") +
        "]"
    : String(element);
}

function finishGesture() {
  clearTimeout(finishTimer);
  const { start, target, events, end, truncated } = gesture;
  const body = JSON.stringify({ start, target, events, end, truncated });
  gesture = undefined;
  pointers.clear();
  fetch("/__display/touches", { method: "POST", body, keepalive: true }).catch(
    () => {},
  );
}

const types = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
  "gotpointercapture",
  "lostpointercapture",
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
];
for (const type of types) {
  document.addEventListener(
    type,
    (event) => {
      const isTouchEvent = type.startsWith("touch");
      if (!isTouchEvent && event.pointerType !== "touch") return;
      const isStart = type === "pointerdown" || type === "touchstart";
      if (isStart && gesture?.end) finishGesture();

      const now = Math.round(performance.now());
      if (!gesture) {
        if (!isStart) return;
        gesture = { start: now, target: describe(event.target), events: [] };
      }
      if (type === "pointerdown") pointers.add(event.pointerId);
      if (type === "pointerup" || type === "pointercancel") {
        pointers.delete(event.pointerId);
      }
      if (isTouchEvent) gesture.hasTouchEvents = true;

      const point = event.touches?.[0] ?? event.changedTouches?.[0] ?? event;
      const sample = [
        now - gesture.start,
        type,
        Math.round(point.clientX ?? -1),
        Math.round(point.clientY ?? -1),
      ];
      // Keep the first samples and the latest event within the POST size limit.
      if (gesture.events.length < 1_000) gesture.events.push(sample);
      else {
        gesture.events[999] = sample;
        gesture.truncated = true;
      }

      const isTouchEnd = type === "touchend" || type === "touchcancel";
      const isPointerEnd = type === "pointerup" || type === "pointercancel";
      if (
        (isTouchEnd && event.touches.length === 0) ||
        (isPointerEnd && !gesture.hasTouchEvents && pointers.size === 0)
      ) {
        gesture.end = type;
        // Leave time for trailing events such as lostpointercapture.
        clearTimeout(finishTimer);
        finishTimer = setTimeout(finishGesture, 300);
      }
    },
    { capture: true, passive: true },
  );
}
