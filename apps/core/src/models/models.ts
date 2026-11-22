import type {
  AddModelSource,
  ChangeModelSource,
  LookAtModelSource,
  ModelCheck,
  ModelChoice,
  ModelSourceInfo,
  ModelSourceLook,
  ModelsInfo,
} from "@meetsanctum/app-sdk";
import { and, eq, gte, sql } from "drizzle-orm";
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
  isInHome,
  listModels,
  ollamaModelName,
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
export const watchEveryMs = 60_000;

type SourceRow = typeof modelSources.$inferSelect;

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
    // A name's addresses; the system's lookup unless a test gives one.
    lookup?: (name: string) => Promise<string[]>;
  },
) {
  const now = options.now ?? (() => new Date());
  // Checks under way, by source, and since when the one in use hasn't
  // answered: both only while the core runs.
  const checking = new Map<string, Promise<void>>();
  const down = new Map<string, Date>();
  const stopping = new AbortController();
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
    const monthStart = dayOf(new Date(now().getTime() - 29 * 86_400_000));
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
    const downSince = down.get(row.id);
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
      ...(row.check ? { check: row.check as ModelCheck } : {}),
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
        address: await resolveHomeAddress(request.address, options.lookup),
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

  /** The model the household picked, as the source lists it now. */
  async function choiceOf(reach: SourceReach, model: string) {
    let models: ModelChoice[];
    try {
      models = await listModels(reach, options.fetchers);
    } catch (error) {
      throw new ActionCallError(
        error instanceof ModelError && error.problem === "key"
          ? "forbidden"
          : "unavailable",
      );
    }
    const choice = models.find((each) => each.id === model);
    if (!choice) throw new ActionCallError("not_found");
    return choice;
  }

  /** Runs a check of a source, once at a time, and keeps how it went. */
  function startCheck(id: string) {
    const under = checking.get(id);
    if (under) return under;
    const run = (async () => {
      const row = rowOf(id);
      let result: Awaited<ReturnType<typeof checkSource>>;
      try {
        result = await checkSource({
          endpoint: endpointOf(reachOf(row), options.fetchers),
          model: row.model,
          inHome: isInHome(row.kind),
          now,
          signal: stopping.signal,
        });
      } catch (error) {
        const problem = error instanceof ModelError ? error.problem : "answer";
        result = {
          check: { at: now().toISOString(), outcome: "failed", problem },
          tokens: { read: 0, written: 0 },
        };
      }
      if (stopping.signal.aborted) return;
      durably(db, () => {
        const still = db
          .select({ id: modelSources.id })
          .from(modelSources)
          .where(eq(modelSources.id, id))
          .get();
        if (!still) return;
        db.update(modelSources)
          .set({ check: result.check })
          .where(eq(modelSources.id, id))
          .run();
        count(id, "check", result.tokens);
      });
      if (result.check.outcome === "failed") {
        if (!down.has(id)) down.set(id, now());
      } else {
        down.delete(id);
      }
    })()
      .catch((error: unknown) => {
        options.log(
          `models: checking ${id} failed (${error instanceof Error ? error.message : String(error)})`,
        );
      })
      .finally(() => checking.delete(id));
    checking.set(id, run);
    return run;
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
    const choice = await choiceOf(reach, request.model);
    const id = randomUUID();
    const row: SourceRow = {
      id,
      kind: request.kind,
      model: choice.id,
      modelName:
        request.kind === "computer" ? ollamaModelName(choice.id) : choice.name,
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
      const inUse = db
        .select({ id: modelSources.id })
        .from(modelSources)
        .where(eq(modelSources.inUse, true))
        .get();
      db.insert(modelSources)
        .values({ ...row, inUse: !inUse })
        .run();
      options.record({
        action: "models.add",
        outcome: "ok",
        ...by,
        subjectId: id,
        detail: named(row),
      });
    });
    void startCheck(id);
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
    down.clear();
    void startCheck(id);
    return info();
  }

  async function change(id: string, request: ChangeModelSource, by: ChangedBy) {
    const row = rowOf(id);
    const set: Partial<SourceRow> = {};
    if (request.computer !== undefined) {
      if (row.kind !== "computer") throw new ActionCallError("invalid_request");
      set.computer = request.computer.trim();
    }
    let reach = reachOf(row);
    if (request.key !== undefined) {
      if (reach.kind === "computer")
        throw new ActionCallError("invalid_request");
      reach = { kind: reach.kind, key: request.key.trim() };
      set.sealedKey = options.sealer.seal(keyBoundTo(id), reach.key);
      set.keyEnd = reach.key.slice(-4);
    }
    if (request.model !== undefined || request.key !== undefined) {
      const choice = await choiceOf(reach, request.model ?? row.model);
      set.model = choice.id;
      set.modelName =
        row.kind === "computer" ? ollamaModelName(choice.id) : choice.name;
    }
    if (Object.keys(set).length === 0) return info();
    set.check = null;
    durably(db, () => {
      db.update(modelSources).set(set).where(eq(modelSources.id, id)).run();
      options.record({
        action: "models.change",
        outcome: "ok",
        ...by,
        subjectId: id,
        detail: {
          ...named({ ...row, ...set }),
          ...(request.key !== undefined ? { key: true } : {}),
        },
      });
    });
    down.delete(id);
    void startCheck(id);
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
    down.delete(id);
    return info();
  }

  /** Asks the source in use for its list, to know whether it answers. */
  async function watchInUse() {
    const row = rows().find((each) => each.inUse);
    if (!row || checking.has(row.id)) return;
    try {
      await listModels(reachOf(row), options.fetchers, stopping.signal);
      down.delete(row.id);
    } catch {
      if (stopping.signal.aborted) return;
      if (!down.has(row.id)) down.set(row.id, now());
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
      rowOf(id);
      void startCheck(id);
      return info();
    },
    use,
    change,
    remove,
    count,
    /** A step of starting: begins watching the source in use. */
    start() {
      void watchInUse();
      watchTimer = setInterval(() => void watchInUse(), watchEveryMs);
      watchTimer.unref();
    },
    /** A step of stopping: ends the watch and any checks under way. */
    async stop() {
      clearInterval(watchTimer);
      stopping.abort();
      await Promise.allSettled([...checking.values()]);
    },
  };
}

export type Models = ReturnType<typeof createModels>;
