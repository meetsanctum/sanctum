// Sums up what `SANCTUM_DISPLAY_FRAMES=true pnpm dev:display` recorded, one
// block per run: the page (dev, built or blank), its label, and whether blur
// and masks were on, with the screens the run saw by their first words.
//
//   node apps/client/dev/display-frames-summary.ts [file] [--json]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Frames = {
  count: number;
  p50: number;
  p95: number;
  durationMs?: number;
  over50: number;
};
type InputEvent = { name: string; delay: number; duration: number };
type LongFrame = {
  duration: number;
  blocking: number;
  render: number;
  scripts?: { duration: number; invoker: string; source: string }[];
};
/** The fields used to summarise one line the display posted. */
type FrameLine = {
  page: string;
  label: string;
  blur: boolean;
  masks: boolean;
  frames?: Frames[];
  moves?: { count: number; p50: number }[];
  events?: InputEvent[];
  loafs?: LongFrame[];
  /** What the screen shows, in its first words, when that changed. */
  shows?: string;
};
type Run = Omit<FrameLine, "frames" | "moves" | "events" | "loafs" | "shows"> &
  Required<Pick<FrameLine, "frames" | "moves" | "events" | "loafs">> & {
    screens: string[];
  };

type Sample = Record<string, unknown>;

function isObject(value: unknown): value is Sample {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNumbers(sample: Sample, ...fields: string[]) {
  return fields.every((field) => Number.isFinite(sample[field]));
}

function hasSamples(value: unknown, check: (sample: Sample) => boolean) {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((sample) => isObject(sample) && check(sample)))
  );
}

function isFrameLine(line: unknown): line is FrameLine {
  return (
    isObject(line) &&
    typeof line.page === "string" &&
    typeof line.label === "string" &&
    typeof line.blur === "boolean" &&
    typeof line.masks === "boolean" &&
    (line.shows === undefined || typeof line.shows === "string") &&
    hasSamples(
      line.frames,
      (frame) =>
        hasNumbers(frame, "count", "p50", "p95", "over50") &&
        (frame.durationMs === undefined || hasNumbers(frame, "durationMs")),
    ) &&
    hasSamples(line.moves, (move) => hasNumbers(move, "count", "p50")) &&
    hasSamples(
      line.events,
      (event) =>
        typeof event.name === "string" &&
        hasNumbers(event, "delay", "duration"),
    ) &&
    hasSamples(
      line.loafs,
      (frame) =>
        hasNumbers(frame, "duration", "blocking", "render") &&
        hasSamples(
          frame.scripts,
          (script) =>
            typeof script.invoker === "string" &&
            typeof script.source === "string" &&
            hasNumbers(script, "duration"),
        ),
    )
  );
}

function readLines(file: string) {
  const lines: FrameLine[] = [];
  for (const [index, text] of readFileSync(file, "utf8")
    .split("\n")
    .entries()) {
    if (!text.trim()) continue;
    let line: unknown;
    try {
      line = JSON.parse(text);
    } catch {
      // The last line may still be getting written while the display records.
    }
    if (isFrameLine(line)) lines.push(line);
    else
      console.error(
        `Skipping invalid frame data on line ${index + 1} of ${file}`,
      );
  }
  return lines;
}

function percentile(values: number[], share: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * share))
  ]!;
}

const median = (values: number[]) => percentile(values, 0.5);

/** One summary per run, in the order the runs began. */
export function summariseRuns(lines: FrameLine[]) {
  const runs = new Map<string, Run>();
  for (const line of lines) {
    const key = [line.page, line.label, line.blur, line.masks].join("|");
    let run = runs.get(key);
    if (!run) {
      run = {
        page: line.page,
        label: line.label,
        blur: line.blur,
        masks: line.masks,
        frames: [],
        moves: [],
        events: [],
        loafs: [],
        screens: [],
      };
      runs.set(key, run);
    }
    run.frames.push(...(line.frames ?? []));
    run.moves.push(...(line.moves ?? []));
    run.events.push(...(line.events ?? []));
    run.loafs.push(...(line.loafs ?? []));
    if (line.shows && !run.screens.includes(line.shows)) {
      run.screens.push(line.shows);
    }
  }
  return [...runs.values()].map((run) => {
    // Lines without a duration were recorded with nominal one-second windows.
    const elapsed =
      run.frames.reduce((sum, each) => sum + (each.durationMs ?? 1000), 0) /
      1000;
    const frames = run.frames.reduce((sum, each) => sum + each.count, 0);
    const slow = run.frames.reduce((sum, each) => sum + each.over50, 0);
    const scripts = new Map<string, number>();
    for (const loaf of run.loafs) {
      for (const script of loaf.scripts ?? []) {
        const name = `${script.invoker} · ${script.source}`;
        scripts.set(name, (scripts.get(name) ?? 0) + script.duration);
      }
    }
    const inputs = run.events.filter((event) =>
      ["pointerdown", "pointerup", "click", "keydown"].includes(event.name),
    );
    return {
      page: run.page,
      label: run.label,
      blur: run.blur,
      masks: run.masks,
      screens: run.screens,
      seconds: Math.round(elapsed * 10) / 10,
      fps: elapsed ? Math.round((frames / elapsed) * 10) / 10 : 0,
      frameGapP50: median(run.frames.map((each) => each.p50)),
      frameGapP95: percentile(
        run.frames.map((each) => each.p95),
        0.95,
      ),
      slowFrameShare: frames ? Math.round((slow / frames) * 1000) / 10 : 0,
      moveGapP50: median(
        run.moves.filter((each) => each.count).map((each) => each.p50),
      ),
      inputs: inputs.length,
      inputDelayP50: median(inputs.map((event) => event.delay)),
      inputDelayP95: percentile(
        inputs.map((event) => event.delay),
        0.95,
      ),
      inputToPaintP95: percentile(
        inputs.map((event) => event.duration),
        0.95,
      ),
      longFrames: run.loafs.length,
      blockingMs: run.loafs.reduce((sum, loaf) => sum + loaf.blocking, 0),
      renderShareOfLongFrames: (() => {
        const total = run.loafs.reduce((sum, loaf) => sum + loaf.duration, 0);
        const render = run.loafs.reduce((sum, loaf) => sum + loaf.render, 0);
        return total ? Math.round((render / total) * 100) : 0;
      })(),
      topScripts: [...scripts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, ms]) => ({ name, ms })),
    };
  });
}

function print(runs: ReturnType<typeof summariseRuns>) {
  for (const run of runs) {
    const effects = [run.blur ? "" : "no blur", run.masks ? "" : "no masks"]
      .filter(Boolean)
      .join(", ");
    console.log(
      `\n${run.page} · ${run.label || "(no label)"}${effects ? ` · ${effects}` : ""}`,
    );
    for (const screen of run.screens) {
      console.log(`  screen   ${screen.slice(0, 80)}`);
    }
    console.log(
      `  frames   ${run.fps} fps over ${run.seconds} s, gap p50 ${run.frameGapP50} ms (median window), gap p95 ${run.frameGapP95} ms (95th percentile of window p95s), ${run.slowFrameShare}% over 50 ms`,
    );
    if (run.moveGapP50) {
      console.log(`  finger   a move every ${run.moveGapP50} ms (p50)`);
    }
    if (run.inputs)
      console.log(
        `  input    ${run.inputs} slow input events, delay p50 ${run.inputDelayP50} ms, p95 ${run.inputDelayP95} ms, to paint p95 ${run.inputToPaintP95} ms`,
      );
    console.log(
      `  long     ${run.longFrames} frames, ${run.blockingMs} ms blocking, ${run.renderShareOfLongFrames}% of their time in the render phase`,
    );
    for (const script of run.topScripts) {
      console.log(`           ${script.ms} ms  ${script.name}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file =
    args.find((arg) => !arg.startsWith("--")) ??
    fileURLToPath(
      new URL("../../../.sanctum-display-frames.jsonl", import.meta.url),
    );
  const runs = summariseRuns(readLines(file));
  if (args.includes("--json")) console.log(JSON.stringify(runs, null, 2));
  else print(runs);
}
