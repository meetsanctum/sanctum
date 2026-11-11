import type {
  AppInfo,
  PieceInfo,
  WorkflowInfo,
  WorkflowNode,
  WorkflowRunInfo,
} from "@meetsanctum/app-sdk";
import type { PersonInfo } from "@meetsanctum/auth-protocol";
import {
  Button,
  Card,
  PageBar,
  PageBarButton,
  PageSection,
  Switch,
} from "@meetsanctum/ui-sdk";
import { ChevronRight, CircleAlert, Pencil, Play } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { blockedBy, blockedWords } from "./blocked";
import { pieceOf, problemOf, type Automations } from "./data";
import { byHand } from "./list";
import { MiniAvatar, PieceIcon, Sentence, Status } from "./parts";
import { momentWords, runWords } from "./when";
import { nodeParts, plain, type Names, type Part } from "./words";

// An automation's page: its cards read as sentences under When, And and
// Then, with Runs on its own beside its triggers, and its history beside
// them on a wide screen. Run, Edit and Done, its way back, sit in the top
// bar; Run is the primary only for one that runs by hand, and Edit for one
// that can't run until it is changed. One an app keeps from running says so
// first, with the way to fix it.

const groups = [
  { kind: "trigger", title: "When" },
  { kind: "condition", title: "And" },
  { kind: "step", title: "Then" },
] as const;

/** A node's sentence, with the value a problem is about marked missing. */
export function partsWithProblems(
  piece: PieceInfo,
  node: WorkflowNode,
  names: Names,
  problems: WorkflowInfo["problems"],
): Part[] {
  const fields = new Set(
    problems
      .filter((problem) => problem.node === node.id && problem.field)
      .map((problem) => problem.field!.split(".")[0]),
  );
  return nodeParts(piece, node, names).map((part) =>
    typeof part !== "string" && fields.has(part.field)
      ? { ...part, missing: true }
      : part,
  );
}

// Why it can't run, and what to do, before its cards.
function CantRun(props: { title: string; detail: string; action?: ReactNode }) {
  return (
    <Card className="max-w-263 flex-row flex-wrap items-center gap-3 px-4 py-3.5">
      <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
      <span
        className="flex min-w-[min(220px,100%)] flex-1 flex-col gap-0.5"
        role="status"
      >
        <span className="text-[15px] leading-5 font-medium">{props.title}</span>
        <span className="text-[13px] leading-[18px] text-muted-foreground">
          {props.detail}
        </span>
      </span>
      {props.action}
    </Card>
  );
}

export function AutomationPage(props: {
  id: string;
  automations: Automations;
  apps: readonly AppInfo[];
  names: Names;
  people: readonly PersonInfo[];
  open(page: string, params?: Record<string, string>): void;
  back(): void;
  /** Opens an app's settings, for one that keeps it from running. */
  openAppSettings(app: string): void;
  openStatus(): void;
}) {
  const { workflows, pieces } = props.automations;
  const workflow = workflows?.find((each) => each.id === props.id);
  const [runs, setRuns] = useState<WorkflowRunInfo[]>();
  const [runsProblem, setRunsProblem] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [working, setWorking] = useState(false);
  const loadRuns = props.automations.runs;
  const reload = props.automations.load;

  // One that is gone, deleted here or elsewhere, leaves for the list.
  const gone = workflows !== undefined && !workflow;
  const { back } = props;
  useEffect(() => {
    if (gone) back();
  }, [gone, back]);

  const updatedAt = workflow?.updatedAt;
  const lastRunId = workflow?.lastRun?.id;
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hasActiveRun = false;
    const load = async () => {
      try {
        const next = await loadRuns(props.id);
        if (!current) return;
        setRuns(next);
        setRunsProblem(undefined);
        const wasActive = hasActiveRun;
        hasActiveRun = next.some(
          (run) => run.status === "running" || run.status === "queued",
        );
        if (wasActive && !hasActiveRun) void reload();
      } catch (error) {
        if (!current) return;
        setRunsProblem(problemOf(error));
      }
      // The run route answers as a run starts. Follow runs already in
      // progress until they end: no live message carries a run.
      if (hasActiveRun) timer = setTimeout(() => void load(), 2_000);
    };
    void load();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [loadRuns, reload, props.id, updatedAt, lastRunId]);

  if (!workflow || !pieces) {
    return <PageBar title="Automation" />;
  }

  const runsByHand = byHand(workflow, pieces);
  const broken = workflow.problems.length > 0;
  // What needs changing comes first; then an app that keeps it from running.
  const blocked = broken ? null : blockedBy(workflow, props.apps, pieces);
  // One an app keeps is changed in that app: it reads and runs here, with no
  // Edit and no switch.
  const keptBy = workflow.app
    ? (props.names.app(workflow.app) ?? workflow.app)
    : undefined;
  const act = async (work: () => Promise<unknown>) => {
    setWorking(true);
    setProblem(undefined);
    try {
      await work();
    } catch (error) {
      setProblem(problemOf(error));
    } finally {
      setWorking(false);
    }
  };

  const nodes = (kind: WorkflowNode["kind"]) =>
    workflow.graph.nodes.filter((node) => node.kind === kind);
  // One that can't run keeps its timers, but won't run when they fire.
  const nextRun = broken
    ? "Next: once it's changed"
    : blocked
      ? "Next: once it can run again"
      : workflow.nextRun
        ? `Next: ${momentWords(new Date(workflow.nextRun), new Date())}`
        : undefined;

  return (
    <>
      <PageBar title={workflow.name}>
        <PageBarButton
          primary={runsByHand}
          icon={Play}
          label="Run"
          disabled={broken || !!blocked || working}
          onClick={() => void act(() => props.automations.run(workflow.id))}
        />
        {!keptBy && (
          <PageBarButton
            primary={broken}
            icon={Pencil}
            label="Edit"
            onClick={() => props.open("edit", { id: workflow.id })}
          />
        )}
        <Button variant="outline" onClick={props.back}>
          Done
        </Button>
      </PageBar>
      {keptBy && (
        <Card className="max-w-263 px-4 py-3.5">
          <span role="note" className="text-[15px] leading-5">
            {keptBy} keeps this automation, so it&apos;s changed in {keptBy}.
          </span>
        </Card>
      )}
      {broken && (
        <CantRun
          title="It can't run until it's changed"
          detail={`${
            workflow.problems.length === 1
              ? workflow.problems[0]!.message
              : `${workflow.problems.length} cards need changing.`
          } ${keptBy ? `Change it in ${keptBy}.` : "Edit it to fix it."}`}
        />
      )}
      {blocked && (
        <CantRun
          {...blockedWords(blocked)}
          action={
            blocked.kind === "stopped" ? (
              <Button variant="outline" onClick={props.openStatus}>
                Open Status
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => props.openAppSettings(blocked.app.id)}
              >
                Open {blocked.app.name} settings
              </Button>
            )
          }
        />
      )}
      {(problem || runsProblem) && (
        <p
          role="alert"
          className="m-0 text-[13px] leading-[18px] font-medium text-(--danger)"
        >
          {problem ?? runsProblem}
        </p>
      )}
      <div className="flex flex-wrap items-start gap-8">
        <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-6 sm:max-w-130">
          {groups.map(({ kind, title }) => {
            const list = nodes(kind);
            if (list.length === 0) return null;
            return (
              <PageSection key={kind} id={`automation-${kind}`} title={title}>
                {list.map((node, index) => {
                  const piece = pieceOf(pieces, node);
                  return (
                    <div key={node.id} className="flex flex-col">
                      {kind === "step" && index > 0 && (
                        <span className="ps-12.5 text-[13px] leading-4 font-medium text-muted-foreground">
                          then
                        </span>
                      )}
                      <div className="flex items-start gap-3 px-2.5 py-1.5">
                        <span className="mt-0.5">
                          <PieceIcon
                            piece={piece}
                            node={node}
                            apps={props.apps}
                            names={props.names}
                          />
                        </span>
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <Sentence
                            parts={
                              piece
                                ? partsWithProblems(
                                    piece,
                                    node,
                                    props.names,
                                    workflow.problems,
                                  )
                                : [node.piece]
                            }
                          />
                          {workflow.problems
                            .filter((each) => each.node === node.id)
                            .map((each) => (
                              <span
                                key={each.message}
                                className="flex items-center gap-1.5 text-[13px] leading-[18px] font-medium"
                              >
                                <CircleAlert
                                  aria-hidden="true"
                                  className="size-3.5 shrink-0"
                                />
                                {each.message}
                              </span>
                            ))}
                        </span>
                      </div>
                    </div>
                  );
                })}
                {kind === "trigger" && !runsByHand && !keptBy && (
                  <label className="flex items-center gap-3 px-2.5 py-2 text-[15px] leading-5">
                    <span className="flex-1">Runs on its own</span>
                    <Switch
                      checked={workflow.enabled}
                      disabled={working}
                      onCheckedChange={(enabled) =>
                        void act(() =>
                          props.automations.update({
                            id: workflow.id,
                            enabled,
                          }),
                        )
                      }
                    />
                  </label>
                )}
              </PageSection>
            );
          })}
        </div>
        <div className="flex min-w-0 flex-[999_1_400px] flex-col gap-2 sm:max-w-125">
          <PageSection id="automation-history" title="History" hint={nextRun}>
            {runs === undefined ? (
              <span className="px-2.5 py-2 text-[13px] text-muted-foreground">
                Loading its runs…
              </span>
            ) : runs.length === 0 ? (
              <span className="px-2.5 py-2 text-[15px] leading-5 text-muted-foreground">
                It hasn't run yet.
              </span>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {runs.map((run, index) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    workflow={workflow}
                    pieces={pieces}
                    apps={props.apps}
                    names={props.names}
                    people={props.people}
                    opened={index === 0}
                  />
                ))}
              </ul>
            )}
          </PageSection>
          <p className="m-0 text-[13px] leading-[18px] text-muted-foreground">
            The latest 50 runs are kept.
          </p>
        </div>
      </div>
    </>
  );
}

/**
 * A run's conditions and steps as they went, and the steps of the graph it
 * ran that it never reached, which the core doesn't record.
 */
function stepsOf(run: WorkflowRunInfo, workflow: WorkflowInfo) {
  if (
    run.version !== workflow.version ||
    run.steps.length === 0 ||
    run.status === "running" ||
    run.status === "queued"
  ) {
    return run.steps;
  }
  const seen = new Set(run.steps.map((step) => step.node));
  const unreached = workflow.graph.nodes
    .filter((node) => node.kind === "step" && !seen.has(node.id))
    .map((node): WorkflowRunInfo["steps"][number] => ({
      node: node.id,
      kind: "step",
      app: node.app ?? null,
      piece: node.piece,
      status: "skipped",
      input: node.config,
      output: null,
      error: null,
      startedAt: run.startedAt ?? run.queuedAt,
      endedAt: null,
    }));
  return [...run.steps, ...unreached];
}

const stepWords: Record<string, string> = {
  succeeded: "Done",
  failed: "Failed",
  skipped: "Not reached",
  cancelled: "Stopped",
  running: "Running",
};

function RunRow(props: {
  run: WorkflowRunInfo;
  workflow: WorkflowInfo;
  pieces: readonly PieceInfo[];
  apps: readonly AppInfo[];
  names: Names;
  people: readonly PersonInfo[];
  opened: boolean;
}) {
  const { run } = props;
  const [open, setOpen] = useState(props.opened && run.steps.length > 0);
  const person = (id: string) => props.people.find((each) => each.id === id);
  const words = runWords(run, (id) => person(id)?.name);
  const at = new Date(run.endedAt ?? run.startedAt ?? run.queuedAt);
  const byPerson = run.startedBy ? person(run.startedBy) : undefined;
  // A run with steps opens to show them; one without is only its line.
  const line = (
    <>
      <Status kind={words.kind} ink className="flex-1 text-[15px] leading-5">
        {words.text}
        {byPerson && words.text === "Run by" && (
          <>
            <MiniAvatar name={byPerson.name} colour={byPerson.colour} />
            {byPerson.name}
          </>
        )}
      </Status>
      <span className="shrink-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
        {momentWords(at, new Date())}
      </span>
      <ChevronRight
        aria-hidden="true"
        className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${
          open ? "rotate-90" : ""
        } ${run.steps.length === 0 ? "invisible" : ""}`}
      />
    </>
  );
  return (
    <li
      className={`flex flex-col rounded-sm ${open ? "bg-foreground/5 pb-2.5" : ""}`}
    >
      {run.steps.length > 0 ? (
        <Button
          variant="row"
          size="row"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="gap-2.5"
        >
          {line}
        </Button>
      ) : (
        <div className="flex min-h-10 items-center gap-2.5 px-2.5 py-2">
          {line}
        </div>
      )}
      {open && (
        <ol className="m-0 mt-0.5 flex list-none flex-col gap-2 py-0 ps-9 pe-2.5">
          {stepsOf(run, props.workflow).map((step) => {
            // History belongs to the graph that ran, even if this node
            // was changed or removed afterwards.
            const node: WorkflowNode = {
              id: step.node,
              kind: step.kind,
              ...(step.app && { app: step.app }),
              piece: step.piece,
              config: (step.input ?? {}) as Record<string, unknown>,
            };
            const piece = pieceOf(props.pieces, node);
            return (
              <li
                key={step.node}
                className={`flex items-start gap-2.5 text-[13px] leading-[18px] ${
                  step.status === "skipped" ? "text-muted-foreground" : ""
                }`}
              >
                <span className="mt-px">
                  <PieceIcon
                    piece={piece}
                    node={node}
                    apps={props.apps}
                    names={props.names}
                    size="small"
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>
                    {piece && node
                      ? plain(nodeParts(piece, node, props.names))
                      : step.piece}
                  </span>
                  {step.error && (
                    <span className="font-medium">{step.error}</span>
                  )}
                </span>
                <span className="shrink-0 font-medium text-muted-foreground">
                  {step.kind === "condition"
                    ? step.status === "succeeded"
                      ? "Passed"
                      : step.status === "skipped"
                        ? "Not met"
                        : (stepWords[step.status] ?? step.status)
                    : (stepWords[step.status] ?? step.status)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </li>
  );
}
