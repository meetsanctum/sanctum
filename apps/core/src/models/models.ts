import type {
  AddModelSource,
  ChangeModelSource,
  LookAtModelSource,
  ModelChoice,
  ModelSourceInfo,
  ModelSourceLook,
  ModelSourceShown,
  ModelsInfo,
  ModelTokens,
  ModelUsage,
} from "@meetsanctum/app-sdk";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { ChangedBy, NewActivityEntry } from "../activity/activity.js";
import { ActionCallError } from "../app-host/errors.js";
import type { Sealer } from "../app-host/secrets.js";
import { durably, type CoreDatabase } from "../database.js";
import {
  AddressProblem,
  addressText,
  resolveHomeAddress,
} from "./addresses.js";
import { checkSource } from "./check.js";
import { ModelError, type ModelEndpoint } from "./client.js";
import {
  endpointOf,
  listModels,
  warmOllama,
  type ModelFetchers,
  type SourceReach,
} from "./endpoints.js";
import { modelSources, modelTokens } from "./schema.js";

// The home's AI models: the sources the household added in Settings, one of
// them in use. The core is the only one that reaches a source or holds its
// key: a provider's key is sealed, never handed back, and goes only to that
// provider. Settings checks a source with a short question and one tool,
// and while one is in use the core asks it for its list of models every
// minute, so Settings can say when it stopped answering. Nothing falls back
// to another source on its own.

/** How often the source in use is asked whether it answers. */
const watchEveryMs = 60_000;
/** How long Ollama on Sanctum may take to load a model, from its disk. */
const warmWithinMs = 5 * 60_000;

type SourceRow = typeof modelSources.$inferSelect;

/** The source in use, as a turn asks it. */
export type SourceInUse = {
  id: string;
  model: string;
  shown: ModelSourceShown;
  // What the activity log says of it.
  detail: ReturnType<typeof named>;
  // Throws a ModelError when its key doesn't open.
  endpoint: () => ModelEndpoint;
};

const providerNames = { openrouter: "OpenRouter", openai: "OpenAI" } as const;
type RunningCheck = { controller: AbortController; run: Promise<void> };

// Why a source's list didn't come: a list is small, so one that takes too
// long is as good as no answer, whatever the model.
function listProblem(error: unknown) {
  const problem = error instanceof ModelError ? error.problem : "answer";
  return problem === "timeout" ? "unreachable" : problem;
}

const keyBoundTo = (id: string) => `models\0${id}`;

/** What the activity log says of a source: its model and where it runs. */
const named = (row: SourceRow) => ({
  kind: row.kind,
  model: row.modelName,
  ...(row.computer ? { computer: row.computer } : {}),
});

export function createModels(
  db: CoreDatabase,
  options: {
    sealer: Sealer;
    fetchers: ModelFetchers;
    record: (entry: NewActivityEntry) => string;
    // The home's time zone, which its days of tokens follow.
    timeZone: () => string | null;
    // The apps that may use the home's AI model, for what Settings shows.
    appsUsing: () => { id: string; name: string }[];
    // Where the manager's Ollama answers while it runs, or null.
    sanctumUrl?: () => Promise<string | null>;
    log: (message: string) => void;
    now?: () => Date;
  },
) {
  const now = options.now ?? (() => new Date());
  // Checks under way, by source, and since when the one in use hasn't
  // answered: both only while the core runs.
  const checking = new Map<string, RunningCheck>();
  const stopping = new AbortController();
  let downSince: Date | undefined;
  let watching: AbortController | undefined;
  let watchTimer: NodeJS.Timeout | undefined;
  // Told of a source that no longer answers as it did: no longer in use,
  // removed, or on another model or key.
  const leaving = new Set<(sourceId: string) => void>();
  const left = (sourceId: string) => {
    for (const listener of leaving) listener(sourceId);
  };

  function dayOf(date: Date) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: options.timeZone() ?? undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }

  const rows = () =>
    db.select().from(modelSources).orderBy(modelSources.createdAt).all();

  const activeRow = () =>
    db.select().from(modelSources).where(eq(modelSources.inUse, true)).get();

  function rowOf(id: string) {
    const row = db
      .select()
      .from(modelSources)
      .where(eq(modelSources.id, id))
      .get();
    if (!row) throw new ActionCallError("not_found");
    return row;
  }

  // Ollama on Sanctum's address, as the manager last gave it: the same name
  // for as long as the service runs.
  let sanctumUrl: string | null = null;
  async function sanctumReach(): Promise<SourceReach> {
    sanctumUrl = (await options.sanctumUrl?.().catch(() => null)) ?? null;
    if (!sanctumUrl)
      throw new ModelError("unreachable", "Ollama isn't running");
    return { kind: "sanctum", url: sanctumUrl };
  }

  // How a source is reached now, asking the manager for Ollama's address.
  async function reachNow(row: SourceRow): Promise<SourceReach> {
    return row.kind === "sanctum" ? sanctumReach() : reachOf(row);
  }

  function reachOf(row: SourceRow): SourceReach {
    if (row.kind === "sanctum") {
      if (!sanctumUrl) throw new ModelError("unreachable");
      return { kind: "sanctum", url: sanctumUrl };
    }
    if (row.kind === "computer") {
      return {
        kind: "computer",
        address: { host: row.host!, port: row.port! },
      };
    }
    let key: string;
    try {
      key = options.sealer.open(keyBoundTo(row.id), row.sealedKey!);
    } catch {
      options.log(`models: ${row.id}'s key doesn't open with this core's key`);
      throw new ModelError("key", "the key doesn't open");
    }
    return { kind: row.kind, key };
  }

  function tokensOf(on: { sourceId: string } | { usedBy: string }) {
    const today = dayOf(now());
    // Shift a calendar date, so a change of the clocks can't move the window.
    const start = new Date(`${today}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 29);
    const monthStart = start.toISOString().slice(0, 10);
    const days = db
      .select({
        day: modelTokens.day,
        tokens: sql<number>`sum(${modelTokens.tokens})`,
      })
      .from(modelTokens)
      .where(
        and(
          "sourceId" in on
            ? eq(modelTokens.sourceId, on.sourceId)
            : eq(modelTokens.usedBy, on.usedBy),
          gte(modelTokens.day, monthStart),
          lte(modelTokens.day, today),
        ),
      )
      .groupBy(modelTokens.day)
      .all();
    return {
      today: days.find((each) => each.day === today)?.tokens ?? 0,
      month: days.reduce((sum, each) => sum + Number(each.tokens), 0),
    };
  }

  function infoOf(row: SourceRow): ModelSourceInfo {
    return {
      id: row.id,
      kind: row.kind,
      model: row.model,
      modelName: row.modelName,
      ...(row.computer ? { computer: row.computer } : {}),
      ...(row.host && row.port
        ? { address: addressText({ host: row.host, port: row.port }) }
        : {}),
      ...(row.keyEnd ? { keyEnd: row.keyEnd } : {}),
      inUse: row.inUse,
      ...(row.check ? { check: row.check } : {}),
      ...(checking.has(row.id) ? { checking: true } : {}),
      ...(row.inUse && downSince ? { downSince: downSince.toISOString() } : {}),
      tokens: tokensOf({ sourceId: row.id }),
    };
  }

  // The last 30 days in the home's time zone, oldest first and today last.
  function lastDays() {
    const today = new Date(`${dayOf(now())}T00:00:00Z`);
    return Array.from({ length: 30 }, (_, back) => {
      const day = new Date(today);
      day.setUTCDate(day.getUTCDate() - (29 - back));
      return day.toISOString().slice(0, 10);
    });
  }

  /** The tokens each day of the last 30, by source, by what asked. */
  function usage(appIds: readonly string[]): ModelUsage {
    const days = lastDays();
    const counted = db
      .select()
      .from(modelTokens)
      .where(
        and(gte(modelTokens.day, days[0]!), lte(modelTokens.day, days.at(-1)!)),
      )
      .all();
    const series = (matches: (row: (typeof counted)[number]) => boolean) =>
      days.map((day) =>
        counted
          .filter((row) => row.day === day && matches(row))
          .reduce((sum, row) => sum + row.tokens, 0),
      );
    return {
      days,
      sources: rows().map(({ id }) => ({
        id,
        tokens: series((row) => row.sourceId === id),
      })),
      apps: appIds.map((id) => ({
        id,
        tokens: series((row) => row.usedBy === id),
      })),
      checks: series((row) => row.usedBy === "check"),
    };
  }

  function info(): ModelsInfo {
    const apps = options
      .appsUsing()
      .map(({ id, name }) => ({ id, name, tokens: tokensOf({ usedBy: id }) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      sources: rows().map(infoOf),
      apps,
      usage: usage(apps.map((app) => app.id)),
    };
  }

  /** The source in use, or null when there's none. */
  function inUse(): SourceInUse | null {
    const row = activeRow();
    if (!row) return null;
    return {
      id: row.id,
      model: row.model,
      shown: {
        name:
          row.kind === "sanctum"
            ? "Sanctum"
            : row.kind === "computer"
              ? (row.computer ?? "Computer")
              : providerNames[row.kind],
        model: row.modelName,
        inHome: row.kind === "computer" || row.kind === "sanctum",
      },
      detail: named(row),
      endpoint: () => endpointOf(reachOf(row), options.fetchers),
    };
  }

  /** Counts the tokens a source read and wrote, for what asked. */
  function count(sourceId: string, usedBy: string, tokens: ModelTokens) {
    const total = tokens.read + tokens.written;
    if (total <= 0) return;
    db.insert(modelTokens)
      .values({ day: dayOf(now()), sourceId, usedBy, tokens: total })
      .onConflictDoUpdate({
        target: [modelTokens.day, modelTokens.sourceId, modelTokens.usedBy],
        set: { tokens: sql`${modelTokens.tokens} + ${total}` },
      })
      .run();
  }

  async function reachFor(request: LookAtModelSource): Promise<SourceReach> {
    if (request.kind === "sanctum") return sanctumReach();
    if (request.kind === "computer") {
      return {
        kind: "computer",
        address: await resolveHomeAddress(request.address),
      };
    }
    return { kind: request.kind, key: request.key.trim() };
  }

  async function look(request: LookAtModelSource): Promise<ModelSourceLook> {
    let reach: SourceReach;
    try {
      reach = await reachFor(request);
    } catch (error) {
      if (error instanceof AddressProblem) {
        return { found: false, problem: error.problem };
      }
      if (error instanceof ModelError) {
        return { found: false, problem: listProblem(error) };
      }
      throw error;
    }
    const address =
      reach.kind === "computer" ? addressText(reach.address) : undefined;
    try {
      const models = await listModels(reach, options.fetchers);
      return { found: true, models, ...(address ? { address } : {}) };
    } catch (error) {
      const problem = listProblem(error);
      return { found: false, problem, ...(address ? { address } : {}) };
    }
  }

  async function choicesForSave(reach: SourceReach): Promise<ModelChoice[]> {
    try {
      return await listModels(reach, options.fetchers);
    } catch (error) {
      throw new ActionCallError(
        error instanceof ModelError && error.problem === "key"
          ? "forbidden"
          : "unavailable",
      );
    }
  }

  function cancelWatch() {
    watching?.abort();
    watching = undefined;
  }

  function cancelCheck(id: string) {
    checking.get(id)?.controller.abort();
    checking.delete(id);
  }

  /** Runs a check of a source, once at a time, and keeps how it went. */
  function startCheck(row: SourceRow) {
    const { id } = row;
    if (checking.has(id)) return;
    if (row.inUse) cancelWatch();
    const controller = new AbortController();
    const signal = AbortSignal.any([stopping.signal, controller.signal]);
    const run = (async () => {
      let result: Awaited<ReturnType<typeof checkSource>>;
      try {
        const reach = await reachNow(row);
        if (reach.kind === "computer" || reach.kind === "sanctum") {
          // A tag can be removed or replaced by a remote model after setup.
          const available = await listModels(reach, options.fetchers, signal);
          if (!available.some((choice) => choice.id === row.model)) {
            throw new ModelError("model");
          }
        }
        signal.throwIfAborted();
        result = await checkSource({
          endpoint: endpointOf(reach, options.fetchers),
          model: row.model,
          inHome: row.kind !== "openrouter" && row.kind !== "openai",
          now,
          signal,
        });
      } catch (error) {
        const problem = error instanceof ModelError ? error.problem : "answer";
        result = {
          check: { at: now().toISOString(), outcome: "failed", problem },
          tokens: { read: 0, written: 0 },
        };
      }
      if (signal.aborted) return;
      const current = rowOf(id);
      durably(db, () => {
        db.update(modelSources)
          .set({ check: result.check })
          .where(eq(modelSources.id, id))
          .run();
        count(id, "check", result.tokens);
      });
      if (current.inUse) {
        if (result.check.outcome !== "failed") downSince = undefined;
        else if (result.check.problem === "unreachable") downSince ??= now();
      }
    })()
      .catch((error: unknown) => {
        options.log(
          `models: checking ${id} failed (${error instanceof Error ? error.message : String(error)})`,
        );
      })
      .finally(() => {
        if (checking.get(id)?.controller === controller) checking.delete(id);
      });
    checking.set(id, { controller, run });
  }

  async function add(request: AddModelSource, by: ChangedBy) {
    let reach: SourceReach;
    try {
      reach = await reachFor(request);
    } catch (error) {
      if (error instanceof AddressProblem) {
        throw new ActionCallError("invalid_request");
      }
      if (error instanceof ModelError) throw new ActionCallError("unavailable");
      throw error;
    }
    const choices = await choicesForSave(reach);
    const choice = choices.find((each) => each.id === request.model);
    if (!choice) throw new ActionCallError("not_found");
    const id = randomUUID();
    const row: SourceRow = {
      id,
      kind: request.kind,
      model: choice.id,
      modelName: choice.name,
      computer: request.kind === "computer" ? request.computer.trim() : null,
      host: reach.kind === "computer" ? reach.address.host : null,
      port: reach.kind === "computer" ? reach.address.port : null,
      sealedKey:
        reach.kind === "computer" || reach.kind === "sanctum"
          ? null
          : options.sealer.seal(keyBoundTo(id), reach.key),
      keyEnd:
        reach.kind === "computer" || reach.kind === "sanctum"
          ? null
          : reach.key.slice(-4),
      inUse: false,
      check: null,
      createdAt: now(),
    };
    durably(db, () => {
      // A source added while none is in use is the one the household
      // wants: the first, or one added after the one in use was removed.
      row.inUse = !activeRow();
      db.insert(modelSources).values(row).run();
      options.record({
        action: "models.add",
        outcome: "ok",
        ...by,
        subjectId: id,
        detail: named(row),
      });
    });
    startCheck(row);
    return info();
  }

  function use(id: string, by: ChangedBy) {
    const row = rowOf(id);
    if (row.inUse) return info();
    const before = activeRow();
    durably(db, () => {
      db.update(modelSources).set({ inUse: false }).run();
      db.update(modelSources)
        .set({ inUse: true })
        .where(eq(modelSources.id, id))
        .run();
      options.record({
        action: "models.use",
        outcome: "ok",
        ...by,
        subjectId: id,
        detail: named(row),
      });
    });
    cancelWatch();
    downSince = undefined;
    if (before) left(before.id);
    startCheck({ ...row, inUse: true });
    return info();
  }

  async function change(id: string, request: ChangeModelSource, by: ChangedBy) {
    const row = rowOf(id);
    const set: Partial<SourceRow> = {};
    if (request.computer !== undefined) {
      if (row.kind !== "computer") throw new ActionCallError("invalid_request");
      set.computer = request.computer.trim();
    }
    const changesConnection =
      request.model !== undefined || request.key !== undefined;
    if (changesConnection) {
      let reach: SourceReach;
      if (request.key === undefined) {
        try {
          reach = await reachNow(row);
        } catch (error) {
          if (error instanceof ModelError) {
            throw new ActionCallError(
              error.problem === "key" ? "forbidden" : "unavailable",
            );
          }
          throw error;
        }
      } else {
        if (row.kind === "computer" || row.kind === "sanctum")
          throw new ActionCallError("invalid_request");
        const key = request.key.trim();
        reach = { kind: row.kind, key };
        set.sealedKey = options.sealer.seal(keyBoundTo(id), key);
        set.keyEnd = key.slice(-4);
      }
      const choices = await choicesForSave(reach);
      const choice = choices.find(
        (each) => each.id === (request.model ?? row.model),
      );
      if (request.model !== undefined && !choice)
        throw new ActionCallError("not_found");
      if (choice) {
        set.model = choice.id;
        set.modelName = choice.name;
      }
      set.check = null;
    }
    if (Object.keys(set).length === 0) return info();
    const current = rowOf(id);
    if (
      changesConnection &&
      (row.model !== current.model || row.sealedKey !== current.sealedKey)
    ) {
      throw new ActionCallError("conflict");
    }
    const changed = { ...current, ...set };
    durably(db, () => {
      db.update(modelSources).set(set).where(eq(modelSources.id, id)).run();
      options.record({
        action: "models.change",
        outcome: "ok",
        ...by,
        subjectId: id,
        detail: {
          ...named(changed),
          ...(request.key !== undefined ? { key: true } : {}),
        },
      });
    });
    if (changesConnection) {
      if (changed.inUse) downSince = undefined;
      left(id);
      cancelCheck(id);
      startCheck(changed);
    }
    return info();
  }

  function remove(id: string, by: ChangedBy) {
    const row = rowOf(id);
    durably(db, () => {
      db.delete(modelSources).where(eq(modelSources.id, id)).run();
      db.delete(modelTokens).where(eq(modelTokens.sourceId, id)).run();
      options.record({
        action: "models.remove",
        outcome: "ok",
        ...by,
        subjectId: id,
        detail: named(row),
      });
    });
    cancelCheck(id);
    left(id);
    if (row.inUse) {
      cancelWatch();
      downSince = undefined;
    }
    return info();
  }

  /** Asks the source in use for its list, to know whether it answers. */
  async function watchInUse() {
    const row = activeRow();
    if (!row || watching || checking.has(row.id) || stopping.signal.aborted)
      return;
    const controller = new AbortController();
    watching = controller;
    try {
      await listModels(
        await reachNow(row),
        options.fetchers,
        controller.signal,
      );
      if (!controller.signal.aborted) downSince = undefined;
    } catch {
      if (!controller.signal.aborted) downSince ??= now();
    } finally {
      if (watching === controller) watching = undefined;
    }
  }

  // Ollama on Sanctum keeps the model in use loaded once it has it, so the
  // first question after a restart doesn't wait for it to load. A model on
  // a computer or with a provider isn't Sanctum's to keep.
  async function warm() {
    const row = activeRow();
    if (row?.kind !== "sanctum") return;
    try {
      const reach = await sanctumReach();
      if (reach.kind !== "sanctum") return;
      await warmOllama(
        options.fetchers.home,
        reach.url,
        row.model,
        AbortSignal.any([stopping.signal, AbortSignal.timeout(warmWithinMs)]),
      );
    } catch (error) {
      if (stopping.signal.aborted) return;
      options.log(
        `models: Ollama on Sanctum didn't load ${row.model} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  /** The models a source offers now, to change to another. */
  async function modelsOf(id: string): Promise<ModelSourceLook> {
    const row = rowOf(id);
    try {
      return {
        found: true,
        models: await listModels(await reachNow(row), options.fetchers),
      };
    } catch (error) {
      const problem = listProblem(error);
      return { found: false, problem };
    }
  }

  return {
    info,
    inUse,
    count,
    /** Hears of each source that stops answering as it did. */
    onLeaving(listener: (sourceId: string) => void) {
      leaving.add(listener);
      return () => void leaving.delete(listener);
    },
    look,
    modelsOf,
    add,
    check(id: string) {
      startCheck(rowOf(id));
      return info();
    },
    use,
    change,
    remove,
    /**
     * A step of starting: has Ollama on Sanctum load the model in use, and
     * begins watching the source in use.
     */
    start() {
      void warm();
      void watchInUse();
      watchTimer = setInterval(() => void watchInUse(), watchEveryMs);
      watchTimer.unref();
    },
    /** A step of stopping: ends the watch and any checks under way. */
    async stop() {
      clearInterval(watchTimer);
      cancelWatch();
      stopping.abort();
      await Promise.allSettled([...checking.values()].map(({ run }) => run));
    },
  };
}

export type Models = ReturnType<typeof createModels>;
