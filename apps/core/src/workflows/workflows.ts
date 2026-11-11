import {
  keptWorkflow,
  runModes,
  workflowGraph,
  type JobRequest,
  type NamedKind,
  type WorkflowInfo,
  type WorkflowProblem,
  type WorkflowRunInfo,
} from "@meetsanctum/app-sdk";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { Activity, RecordActivity } from "../activity/activity.js";
import type { Rule } from "../app-host/gate.js";
import type { AppHost } from "../app-host/host.js";
import type { CoreDatabase } from "../database.js";
import type { Devices } from "../devices/devices.js";
import type { Lights } from "../devices/lights.js";
import type { Motion } from "../devices/motion.js";
import type { Entities } from "../entities/entities.js";
import type { PlacesModule } from "../places/places.js";
import { createEngine, type WorkflowRow } from "./engine.js";
import { createFiring } from "./firing.js";
import { sameValue } from "./graph.js";
import { createJobs, type JobRow, type SunDays } from "./jobs.js";
import { createKeptGrants } from "./kept-grants.js";
import { createPieces } from "./pieces.js";
import { createRuns } from "./runs.js";
import { workflows } from "./schema.js";
import { hostTimeZone } from "./time.js";
import { createTimers, lateness } from "./timers.js";

// The Workflows module: the household's rules and apps' jobs. It keeps
// workflows, fires their triggers from app events, device and entity
// changes, remotes' presses and timers, and runs due jobs, checking every
// few seconds against the clock.

const tickMs = 10_000;

// Automations belong to the whole household: every person and every shared
// client reads, changes and runs them. Widget tokens do not.
export const workflowRules = {
  read: { tier: "read" },
  change: { tier: "write" },
} as const satisfies Record<string, Rule>;

// Who changed a workflow through the routes: the person at a personal
// client, none at a shared one, and the client.
export type WorkflowChangedBy = { personId?: string; clientId: string };

export class WorkflowsError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_workflow" | "kept_by_app",
    readonly problems: WorkflowProblem[] = [],
  ) {
    super(code);
  }
}

const name = z.string().trim().min(1).max(120);
const id = z.string().min(1).max(64);

export const newWorkflow = z.strictObject({
  name,
  enabled: z.boolean().default(true),
  runMode: z.enum(runModes).default("single"),
  graph: workflowGraph,
});
export const workflowChanges = z.strictObject({
  id,
  name: name.optional(),
  enabled: z.boolean().optional(),
  runMode: z.enum(runModes).optional(),
  graph: workflowGraph.optional(),
});
export const workflowRef = z.strictObject({ id });

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createWorkflows(
  db: CoreDatabase,
  options: {
    host: Pick<
      AppHost,
      "has" | "holds" | "isRunning" | "pieces" | "list" | "action" | "invoke"
    >;
    devices: Pick<Devices, "get" | "command">;
    // The rooms and zones workflows name, which may be removed.
    places: Pick<PlacesModule, "hasRoom" | "hasZone">;
    // The lights of a place together, which lights pieces ask about and
    // switch.
    lights: Pick<Lights, "are" | "switch">;
    // Motion and the light level in a place, which motion pieces read.
    motion: Pick<Motion, "at" | "around" | "lightLevel" | "name">;
    // The entities apps bring, which entity conditions read.
    entities: Pick<Entities, "get" | "list">;
    record: RecordActivity;
    // Where runs go, and what their steps run within.
    activity?: Pick<Activity, "for" | "within" | "cause" | "update">;
    log: (message: string) => void;
    now?: () => Date;
    // The home's time zone, which Places keeps with its location; the
    // host's while it has none.
    timeZone?: () => string | null;
    // Sunrises and sunsets from the app that knows the sun; none while no
    // app does.
    sun?: () => SunDays | null;
  },
) {
  const { host, record, log } = options;
  const now = options.now ?? (() => new Date());
  const clock = {
    now,
    timeZone: () => options.timeZone?.() ?? hostTimeZone(),
    sun: () => options.sun?.() ?? null,
  };
  const runs = createRuns(db, now);
  const pieces = createPieces({
    host,
    devices: options.devices,
    places: options.places,
    entities: options.entities,
    hasSun: () => (clock.sun()?.length ?? 0) > 0,
  });
  const keptGrants = createKeptGrants({ pieces, devices: options.devices });
  // What the app that keeps a workflow holds, while it is installed.
  const holdingOf = (workflow: WorkflowRow) =>
    workflow.app ? host.holds(workflow.app) : null;
  // What the grants of the app that keeps a workflow keep it from doing:
  // it is suspended meanwhile.
  function suspension(workflow: WorkflowRow): WorkflowProblem[] {
    const holding = holdingOf(workflow);
    return holding ? keptGrants.problems(holding, workflow.graph) : [];
  }
  // Whether a workflow's triggers may start it now: the household's
  // always, one an app keeps while the app runs and its grants cover it.
  const mayRun = (workflow: WorkflowRow) =>
    !workflow.app ||
    (host.isRunning(workflow.app) && suspension(workflow).length === 0);
  const engine = createEngine({
    runs,
    activity: options.activity,
    pieces,
    actingAs(workflow) {
      if (!workflow.app) return null;
      const holding = holdingOf(workflow);
      if (!holding || !host.isRunning(workflow.app)) {
        const message = `${workflow.app} is not running`;
        return {
          view: { kinds: new Set<never>() },
          refusal: () => message,
          problems: () => [{ node: null, field: null, message }],
        };
      }
      return {
        view: keptGrants.view(holding),
        refusal: (node) => keptGrants.refusal(holding, node),
        problems: () => keptGrants.problems(holding, workflow.graph),
      };
    },
    host,
    devices: options.devices,
    lights: options.lights,
    motion: options.motion,
    entities: options.entities,
    timeZone: clock.timeZone,
    now,
    log,
  });
  const timers = createTimers(db, {
    pieces,
    engine,
    clock,
    mayRun,
    motion: options.motion,
  });
  const firing = createFiring({
    rows,
    pieces,
    engine,
    mayRun,
    motion: options.motion,
    timers,
  });
  const jobs = createJobs(db, { host, clock });
  const runningJobs = new Map<string, Promise<void>>();

  function rows() {
    return db.select().from(workflows).all();
  }

  function row(workflowId: string) {
    const found = db
      .select()
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .get();
    if (!found) {
      throw new WorkflowsError("not_found");
    }
    return found;
  }

  // One that people change: a workflow an app keeps changes only through
  // the app.
  function householdRow(workflowId: string) {
    const found = row(workflowId);
    if (found.app) {
      throw new WorkflowsError("kept_by_app");
    }
    return found;
  }

  // The workflow an app keeps by its key, if any.
  function keptRow(app: string, key: string) {
    return db
      .select()
      .from(workflows)
      .where(and(eq(workflows.app, app), eq(workflows.appKey, key)))
      .get();
  }

  // Workflows as clients see them, with their latest run and, while they
  // are on, their next one. A workflow that is off keeps its timers, which
  // move on without running it.
  function infos(found: WorkflowRow[], workflowId?: string): WorkflowInfo[] {
    const last = runs.latest(workflowId);
    const next = timers.next(workflowId);
    return found.map((workflow) => {
      const { problems, warnings } = pieces.check(workflow.graph);
      const nextAt = workflow.enabled ? next.get(workflow.id) : undefined;
      return {
        id: workflow.id,
        name: workflow.name,
        enabled: workflow.enabled,
        runMode: workflow.runMode,
        graph: workflow.graph,
        version: workflow.version,
        createdBy: workflow.createdBy,
        app: workflow.app,
        appKey: workflow.appKey,
        problems,
        warnings,
        suspended: suspension(workflow),
        lastRun: last.get(workflow.id) ?? null,
        nextRun: nextAt?.toISOString() ?? null,
        createdAt: workflow.createdAt.toISOString(),
        updatedAt: workflow.updatedAt.toISOString(),
      };
    });
  }

  // Due jobs of running apps; the jobs of an app that is absent or paused
  // wait for it. A job still running from its last time skips this one.
  function runJobs(at: Date) {
    jobs.refreshSunTimers(at);
    for (const job of jobs.due(at)) {
      if (!host.isRunning(job.app)) {
        continue;
      }
      const recurring = !("at" in job.when);
      const late = at.getTime() - job.nextAt!.getTime() > lateness;
      const key = `${job.app}\u0000${job.key}`;
      // Unlike a recurring occurrence, a one-off replacement has no next
      // time to try. Keep it until the earlier call with its key finishes.
      if (!recurring && runningJobs.has(key)) continue;
      jobs.advance(job);
      if ((recurring && late) || runningJobs.has(key)) {
        continue;
      }
      const work = runJob(job).finally(() => runningJobs.delete(key));
      runningJobs.set(key, work);
    }
  }

  async function runJob(job: JobRow) {
    try {
      await host.invoke({
        actor: { kind: "app", id: job.app },
        appId: job.app,
        actionId: job.action,
        input: job.input?.value,
      });
    } catch (error) {
      log(`workflows: job ${job.key} of ${job.app} failed (${message(error)})`);
    }
  }

  let timer: NodeJS.Timeout | undefined;
  let held = false;
  const unlessHeld =
    <Happened extends unknown[]>(fire: (...happened: Happened) => void) =>
    (...happened: Happened) => {
      if (!held) fire(...happened);
    };

  const module = {
    list(): WorkflowInfo[] {
      return infos(rows()).sort((a, b) => a.name.localeCompare(b.name));
    },

    get(workflowId: string): WorkflowInfo {
      return infos([row(workflowId)], workflowId)[0]!;
    },

    /** A workflow's name and the app that keeps it, if it is still there. */
    brief(workflowId: string): { name: string; app: string | null } | null {
      return (
        db
          .select({ name: workflows.name, app: workflows.app })
          .from(workflows)
          .where(eq(workflows.id, workflowId))
          .get() ?? null
      );
    },

    /**
     * The workflows whose config names a room, a zone or a device, by the
     * fields their pieces declare, for the warning before it is removed.
     */
    naming(kind: NamedKind, namedId: string): { id: string; name: string }[] {
      return rows()
        .filter((workflow) =>
          pieces
            .named(workflow.graph)
            .some((each) => each.kind === kind && each.id === namedId),
        )
        .map(({ id: workflowId, name: workflowName }) => ({
          id: workflowId,
          name: workflowName,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    /** The pieces a workflow may use now (GET /api/workflows/pieces). */
    pieces: () => pieces.list(),

    /** A workflow's latest runs, newest first. */
    runs(workflowId: string): WorkflowRunInfo[] {
      row(workflowId);
      return runs.list(workflowId);
    },

    run: (runId: string) => runs.get(runId),

    add(
      by: WorkflowChangedBy,
      input: z.output<typeof newWorkflow>,
    ): WorkflowInfo {
      const { problems } = pieces.check(input.graph, { saving: true });
      if (problems.length > 0) {
        throw new WorkflowsError("invalid_workflow", problems);
      }
      const at = now();
      const workflowId = randomUUID();
      db.transaction(() => {
        db.insert(workflows)
          .values({
            id: workflowId,
            name: input.name,
            enabled: input.enabled,
            runMode: input.runMode,
            graph: input.graph,
            version: 1,
            createdBy: by.personId ?? null,
            createdAt: at,
            updatedAt: at,
          })
          .run();
        timers.set(row(workflowId));
        record({
          action: "workflow.add",
          outcome: "ok",
          ...by,
          subjectId: workflowId,
        });
      });
      return module.get(workflowId);
    },

    // Its graph can only be saved whole; turning it on or off, renaming it
    // and changing its run mode need no check, so a broken workflow can be
    // switched off.
    update(
      by: WorkflowChangedBy,
      input: z.output<typeof workflowChanges>,
    ): WorkflowInfo {
      const current = householdRow(input.id);
      if (input.graph) {
        const { problems } = pieces.check(input.graph, { saving: true });
        if (problems.length > 0) {
          throw new WorkflowsError("invalid_workflow", problems);
        }
      }
      const graphChanged =
        input.graph !== undefined && !sameValue(input.graph, current.graph);
      db.transaction(() => {
        db.update(workflows)
          .set({
            ...(input.name !== undefined && { name: input.name }),
            ...(input.enabled !== undefined && { enabled: input.enabled }),
            ...(input.runMode !== undefined && { runMode: input.runMode }),
            ...(graphChanged && {
              graph: input.graph,
              version: current.version + 1,
            }),
            updatedAt: now(),
          })
          .where(eq(workflows.id, input.id))
          .run();
        timers.set(row(input.id), current.graph);
        record({
          action: "workflow.update",
          outcome: "ok",
          ...by,
          subjectId: input.id,
        });
      });
      if (graphChanged) {
        engine.forget(input.id);
      }
      return module.get(input.id);
    },

    remove(by: WorkflowChangedBy, input: z.output<typeof workflowRef>) {
      const { name } = householdRow(input.id);
      engine.forget(input.id);
      db.transaction(() => {
        db.delete(workflows).where(eq(workflows.id, input.id)).run();
        // Its name, for the runs that name it.
        record({
          action: "workflow.remove",
          outcome: "ok",
          ...by,
          subjectId: input.id,
          detail: { name },
        });
      });
    },

    /**
     * Runs a workflow by hand, even while it is off (v1): from its manual
     * triggers, or from all its triggers when it has none. A run from a
     * shared client has no person behind it, so it keeps the client's name.
     */
    runByHand(
      by: WorkflowChangedBy & { clientName?: string },
      input: z.output<typeof workflowRef>,
    ) {
      const workflow = row(input.id);
      // One an app keeps runs only while the app runs.
      if (workflow.app && !host.isRunning(workflow.app)) {
        throw new WorkflowsError("invalid_workflow", [
          {
            node: null,
            field: null,
            message: `The app ${workflow.app} is ${host.has(workflow.app) ? "paused" : "not installed"}`,
          },
        ]);
      }
      const triggers = workflow.graph.nodes.filter(
        (node) => node.kind === "trigger",
      );
      const manual = triggers.filter(
        (node) => !node.app && node.piece === "manual",
      );
      const runId = engine.fire(workflow, {
        nodes: (manual.length > 0 ? manual : triggers).map((node) => node.id),
        key: null,
        data: {},
        startedBy: by.personId,
        startedOn: by.personId === undefined ? by.clientName : undefined,
        startedFrom: by.clientId,
      })!;
      return runs.get(runId)!;
    },

    /**
     * The workflows an app keeps by its own keys (ctx.workflows), from the
     * core's pieces and its own only, whole and within the app's grants
     * (kept-grants.ts): a workflow that is not fails the app's call. Putting
     * a key again replaces the workflow and keeps its id, so its runs stay
     * with it.
     */
    kept: {
      put(app: string, input: unknown): WorkflowInfo {
        const parsed = keptWorkflow.safeParse(input);
        if (!parsed.success) {
          throw new Error(
            `${app} put a workflow the core cannot keep: ${z.prettifyError(parsed.error)}`,
          );
        }
        const { key, graph, ...fields } = parsed.data;
        const foreign = graph.nodes.find(
          (node) => node.app && node.app !== app,
        );
        if (foreign) {
          throw new Error(
            `${app}'s workflow ${key} uses ${foreign.app}'s ${foreign.piece}, which only that app may`,
          );
        }
        const { problems } = pieces.check(graph, { saving: true });
        if (problems.length > 0) {
          throw new Error(
            `${app}'s workflow ${key} is not whole: ${problems.map((problem) => problem.message).join("; ")}`,
          );
        }
        // It acts with the app's grants, which must cover it. A call that
        // outlived the app's removal keeps nothing.
        const holding = host.holds(app);
        if (!holding) {
          throw new Error(`${app} is not installed`);
        }
        const refused = keptGrants.problems(holding, graph);
        if (refused.length > 0) {
          throw new Error(
            `${app}'s workflow ${key} goes beyond what it holds: ${refused.map((problem) => problem.message).join("; ")}`,
          );
        }
        const by = { actor: `app:${app}` };
        const current = keptRow(app, key);
        if (
          current &&
          sameValue(
            { ...fields, graph },
            {
              name: current.name,
              enabled: current.enabled,
              runMode: current.runMode,
              graph: current.graph,
            },
          )
        ) {
          // Nothing changed, so nothing is written or logged.
          return module.get(current.id);
        }
        if (current) {
          const graphChanged = !sameValue(graph, current.graph);
          db.transaction(() => {
            db.update(workflows)
              .set({
                ...fields,
                ...(graphChanged && { graph, version: current.version + 1 }),
                updatedAt: now(),
              })
              .where(eq(workflows.id, current.id))
              .run();
            timers.set(row(current.id), current.graph);
            record({
              action: "workflow.update",
              outcome: "ok",
              ...by,
              subjectId: current.id,
            });
          });
          if (graphChanged) {
            engine.forget(current.id);
          }
          return module.get(current.id);
        }
        const at = now();
        const workflowId = randomUUID();
        db.transaction(() => {
          db.insert(workflows)
            .values({
              id: workflowId,
              ...fields,
              graph,
              version: 1,
              createdBy: null,
              app,
              appKey: key,
              createdAt: at,
              updatedAt: at,
            })
            .run();
          timers.set(row(workflowId));
          record({
            action: "workflow.add",
            outcome: "ok",
            ...by,
            subjectId: workflowId,
          });
        });
        return module.get(workflowId);
      },

      remove(app: string, key: string) {
        const current = keptRow(app, key);
        if (!current) {
          return;
        }
        db.transaction(() => {
          db.delete(workflows).where(eq(workflows.id, current.id)).run();
          record({
            action: "workflow.remove",
            outcome: "ok",
            actor: `app:${app}`,
            subjectId: current.id,
            detail: { name: current.name },
          });
        });
        // Once it's really gone, so a failure above leaves its runs going.
        engine.cancelRuns(current.id);
        engine.forget(current.id);
      },

      /**
       * Removes an app's workflows but those it claimed, for an update's
       * commit. This runs inside its transaction, so what it answers ends
       * their runs, once that has committed.
       */
      sweep(app: string, claimed: ReadonlySet<string>) {
        const going = rows().filter(
          ({ app: owner, appKey }) =>
            owner === app && appKey !== null && !claimed.has(appKey),
        );
        for (const workflow of going) {
          db.delete(workflows).where(eq(workflows.id, workflow.id)).run();
          record({
            action: "workflow.remove",
            outcome: "ok",
            actor: `app:${app}`,
            subjectId: workflow.id,
            detail: { name: workflow.name },
          });
        }
        return () => {
          for (const { id } of going) {
            engine.cancelRuns(id);
            engine.forget(id);
          }
        };
      },

      list(app: string): WorkflowInfo[] {
        return infos(rows().filter((workflow) => workflow.app === app)).sort(
          (a, b) => a.name.localeCompare(b.name),
        );
      },
    },

    // What happens: an app's event, a device's change, a remote's press,
    // an entity's change (firing.ts).
    appEvent: unlessHeld(firing.appEvent),
    deviceChanged: unlessHeld(firing.deviceChanged),
    pressed: unlessHeld(firing.pressed),
    entityChanged: unlessHeld(firing.entityChanged),

    /** Apps' jobs, for the app host. */
    jobs: {
      schedule: (app: string, request: JobRequest) =>
        jobs.schedule(app, request),
      cancel: (app: string, key: string) => jobs.cancel(app, key),
      list: (app: string) => jobs.list(app),
    },

    /** Fires due timers and runs due jobs. */
    tick() {
      const at = now();
      try {
        timers.fire(at);
        runJobs(at);
      } catch (error) {
        log(`workflows: timers failed (${message(error)})`);
      }
    },

    /**
     * Runs nothing until `start`, for a core on trial: a rollback puts its
     * data back, and what a workflow did to the home it can't. What's due
     * stays due, and what happens meanwhile is lost, as it is while the core
     * restarts.
     */
    hold() {
      held = true;
    },

    /**
     * Ends the runs the core was running when it stopped, then checks the
     * timers now and every few seconds; tests tick by hand.
     */
    start(startOptions: { ticking?: boolean } = {}) {
      held = false;
      const ended = runs.interrupted();
      if (ended > 0) {
        log(`workflows: ${ended} interrupted runs ended as failed`);
      }
      if (startOptions.ticking === false) {
        return;
      }
      module.tick();
      timer = setInterval(() => module.tick(), tickMs);
      timer.unref();
    },

    /** Resolves once every run and job started so far has ended. */
    async settled() {
      await engine.settled();
      while (runningJobs.size > 0) {
        await Promise.allSettled([...runningJobs.values()]);
        await engine.settled();
      }
    },

    close() {
      clearInterval(timer);
      timer = undefined;
    },
  };
  return module;
}

export type Workflows = ReturnType<typeof createWorkflows>;
