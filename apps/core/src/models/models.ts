import type {
  AddModelSource,
  ChangeModelSource,
  LookAtModelSource,
  ModelChoice,
  ModelSourceInfo,
  ModelSourceLook,
  ModelsInfo,
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
import { ModelError, type ModelTokens } from "./client.js";
import {
  endpointOf,
  listModels,
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

type SourceRow = typeof modelSources.$inferSelect;
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

  function reachOf(row: SourceRow): SourceReach {
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

  function tokensOf(sourceId: string) {
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
          eq(modelTokens.sourceId, sourceId),
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
      tokens: tokensOf(row.id),
    };
  }

  function info(): ModelsInfo {
    return { sources: rows().map(infoOf) };
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
        const reach = reachOf(row);
        if (reach.kind === "computer") {
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
          inHome: row.kind === "computer",
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
        reach.kind === "computer"
          ? null
          : options.sealer.seal(keyBoundTo(id), reach.key),
      keyEnd: reach.kind === "computer" ? null : reach.key.slice(-4),
      inUse: false,
      check: null,
      createdAt: now(),
    };
    durably(db, () => {
      // The first source is the one in use.
      row.inUse = !db.select({ id: modelSources.id }).from(modelSources).get();
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
          reach = reachOf(row);
        } catch (error) {
          if (error instanceof ModelError && error.problem === "key") {
            throw new ActionCallError("forbidden");
          }
          throw error;
        }
      } else {
        if (row.kind === "computer")
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
      await listModels(reachOf(row), options.fetchers, controller.signal);
      if (!controller.signal.aborted) downSince = undefined;
    } catch {
      if (!controller.signal.aborted) downSince ??= now();
    } finally {
      if (watching === controller) watching = undefined;
    }
  }

  /** The models a source offers now, to change to another. */
  async function modelsOf(id: string): Promise<ModelSourceLook> {
    const row = rowOf(id);
    try {
      return {
        found: true,
        models: await listModels(reachOf(row), options.fetchers),
      };
    } catch (error) {
      const problem = listProblem(error);
      return { found: false, problem };
    }
  }

  return {
    info,
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
    /** A step of starting: begins watching the source in use. */
    start() {
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
