import type {
  ActivityInfo,
  ActivityKind,
  ActivityPage,
} from "@meetsanctum/app-sdk";
import type { LiveFeed } from "@meetsanctum/ui-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { coreJson } from "../core-fetch";
import { midnight } from "../device-history-data";

// What the activity lists show: pages of entries from GET /api/activity,
// newest first, and each entry the live socket brings that belongs, in its
// place, or in place of the one it changes. Live entries fill up to 200
// rows; loading older pages expands that window.

export type ActivityFilter = { device?: string; kind?: ActivityKind };

const kept = 200;
const pageSize = 50;

/**
 * An entry the live socket brought, in its place in a newest-first list,
 * or in place of the one it changes, keeping `limit` at most.
 */
export function applyActivity(
  current: readonly ActivityInfo[],
  entry: ActivityInfo,
  belongs: (entry: ActivityInfo) => boolean,
  limit = kept,
): ActivityInfo[] {
  const previous = current.find((each) => each.id === entry.id);
  if (belongs(entry) && previous?.at === entry.at) {
    return current
      .map((each) => (each.id === entry.id ? entry : each))
      .slice(0, limit);
  }
  const others = current.filter((each) => each.id !== entry.id);
  if (!belongs(entry)) {
    return others.length === current.length ? [...current] : others;
  }
  const at = Date.parse(entry.at);
  const index = others.findIndex((each) => Date.parse(each.at) <= at);
  const next =
    index < 0
      ? [...others, entry]
      : [...others.slice(0, index), entry, ...others.slice(index)];
  return next.slice(0, limit);
}

/** Whether an entry belongs in a list with this filter. */
export function belongsTo(filter: ActivityFilter) {
  return (entry: ActivityInfo) =>
    (!filter.device || entry.subject?.id === filter.device) &&
    (!filter.kind || entry.kind === filter.kind);
}

const dayMs = 24 * 60 * 60_000;

/** A day's heading: Today, Yesterday, or the day and date. */
export function dayHeading(at: number, now = Date.now()) {
  const day = midnight(at);
  const today = midnight(now);
  if (day === today) return "Today";
  if (day === midnight(now, 1)) return "Yesterday";
  const date = new Date(at);
  return date.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(today - day > 300 * dayMs ? { year: "numeric" } : {}),
  });
}

export type Day = { key: number; heading: string; entries: ActivityInfo[] };

/** Entries by the local day they happened on, newest first. */
export function daysOf(entries: readonly ActivityInfo[], now = Date.now()) {
  const days: Day[] = [];
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    const key = midnight(at);
    const last = days.at(-1);
    if (last?.key === key) {
      last.entries.push(entry);
    } else {
      days.push({ key, heading: dayHeading(at, now), entries: [entry] });
    }
  }
  return days;
}

export type Folded = { entry: ActivityInfo; under: ActivityInfo[] };

// What other entries may fold under: a press, a run, an app's action.
const leads = (entry: ActivityInfo) =>
  entry.action === "device.press" ||
  entry.action === "workflow.run" ||
  entry.source.includes(".");

/**
 * The home's list folds what a press, a run or an app's action led to under
 * it, when it is in the list: the runs, apps' actions, commands and
 * workflows an app keeps that it caused. A run an app keeps for a press is
 * the app's own working, so only what it did shows.
 */
export function foldCauses(entries: readonly ActivityInfo[]): Folded[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  // The furthest press or run behind an entry that the list has.
  const leadOf = (entry: ActivityInfo) => {
    let lead: string | undefined;
    let at = entry;
    for (let depth = 0; depth < 6 && at.causeId; depth++) {
      const cause = byId.get(at.causeId);
      if (!cause) break;
      if (leads(cause)) lead = cause.id;
      at = cause;
    }
    return lead;
  };
  const rows = new Map<string, Folded>();
  const folded: [string, ActivityInfo][] = [];
  for (const entry of entries) {
    const lead = leadOf(entry);
    if (lead) {
      if (!(entry.action === "workflow.run" && entry.run?.app)) {
        folded.push([lead, entry]);
      }
    } else {
      rows.set(entry.id, { entry, under: [] });
    }
  }
  for (const [lead, entry] of folded) rows.get(lead)?.under.push(entry);
  return [...rows.values()];
}

export type ActivityState = "loading" | "ready" | "failed";

/** The log as a list shows it: loaded, then followed live. */
export function useActivity(
  filter: ActivityFilter,
  live: LiveFeed,
  options: { limit?: number } = {},
) {
  const limit = options.limit ?? pageSize;
  const [{ entries, more }, setPage] = useState<ActivityPage>({
    entries: [],
    more: false,
  });
  const [state, setState] = useState<ActivityState>("loading");
  const [older, setOlder] = useState<ActivityState>("ready");
  const [attempt, setAttempt] = useState(0);
  const { device, kind } = filter;
  const current = useRef(0);
  const isLoadingOlder = useRef(false);
  // The filter of what is shown, so a refresh can tell it shows the same.
  const shown = useRef<string | null>(null);

  const query = useCallback(
    (before?: string, count = limit) => {
      const params = new URLSearchParams({ limit: String(count) });
      if (device) params.set("device", device);
      if (kind) params.set("kind", kind);
      if (before) params.set("before", before);
      return coreJson<ActivityPage>(`/api/activity?${params}`);
    },
    [device, kind, limit],
  );

  useEffect(() => {
    const load = ++current.current;
    const belongs = belongsTo({ device, kind });
    // What arrives live while the first page loads joins it.
    let heard: ActivityInfo[] = [];
    let loaded = false;
    let hasTrimmed = false;
    // A refresh, as when the live connection is back, keeps what is shown
    // until the first page comes again; another filter starts afresh.
    const key = JSON.stringify([device ?? null, kind ?? null]);
    const isRefresh = shown.current === key;
    shown.current = key;
    isLoadingOlder.current = false;
    if (!isRefresh) {
      setState("loading");
      setPage({ entries: [], more: false });
    }
    setOlder("ready");
    const stop = live.subscribe({
      message(message) {
        if (message.type !== "activity") return;
        if (!loaded) {
          const next = applyActivity(heard, message.entry, belongs, kept + 1);
          hasTrimmed ||= next.length > kept;
          heard = next.slice(0, kept);
          return;
        }
        // Keep the pagination anchor and its neighbours until the answer
        // arrives, so a busy live stream cannot leave a gap between pages.
        const isKeepingAll = isLoadingOlder.current;
        setPage((page) => {
          const capacity = Math.max(
            kept,
            page.entries.length + (isKeepingAll ? 1 : 0),
          );
          const next = applyActivity(
            page.entries,
            message.entry,
            belongs,
            capacity + 1,
          );
          return {
            entries: next.slice(0, capacity),
            more: page.more || next.length > capacity,
          };
        });
      },
      refresh: () => setAttempt((count) => count + 1),
    });
    query()
      .then((page) => {
        if (load !== current.current) return;
        loaded = true;
        const merged = heard.reduceRight(
          (list, entry) => applyActivity(list, entry, belongs, Infinity),
          page.entries,
        );
        setPage({
          entries: merged.slice(0, kept),
          more: page.more || hasTrimmed || merged.length > kept,
        });
        setState("ready");
      })
      .catch(() => {
        if (load === current.current && !isRefresh) setState("failed");
      });
    return () => {
      current.current++;
      stop();
    };
  }, [query, live, device, kind, attempt]);

  const loadOlder = useCallback(() => {
    const last = entries.at(-1);
    if (!last || older === "loading") return;
    setOlder("loading");
    isLoadingOlder.current = true;
    const load = current.current;
    query(last.id, pageSize)
      .then((page) => {
        if (load !== current.current) return;
        setPage((currentPage) => ({
          entries: [
            ...currentPage.entries,
            ...page.entries.filter(
              (entry) =>
                !currentPage.entries.some((each) => each.id === entry.id),
            ),
          ],
          more: page.more,
        }));
        isLoadingOlder.current = false;
        setOlder("ready");
      })
      .catch(() => {
        if (load === current.current) {
          isLoadingOlder.current = false;
          setOlder("failed");
        }
      });
  }, [entries, older, query]);

  return {
    entries,
    state,
    more,
    older,
    loadOlder,
    retry: () => setAttempt((count) => count + 1),
  };
}
