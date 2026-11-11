import type { AppInfo, PieceInfo, WorkflowInfo } from "@meetsanctum/app-sdk";
import {
  Button,
  Card,
  PageBar,
  PageBarButton,
  PageSection,
} from "@meetsanctum/ui-sdk";
import { ChevronRight, CircleAlert, Play, Plus } from "lucide-react";
import { useState } from "react";

import { blockedBy, blockedLine } from "./blocked";
import { pieceOf, problemOf, type Automations } from "./data";
import { PieceIcon, Status, TriggerCard } from "./parts";
import { listStatus, nextOf, timeWords } from "./when";
import {
  cardOf,
  compareGroups,
  groupOf,
  nodeParts,
  plain,
  type Names,
} from "./words";

// Automations' list: each workflow once, grouped by the type of what starts
// it, in one column across the page. A row leads with its trigger's card,
// then its name and what it does, and its status on the right; a row that
// runs by hand has Run before its chevron. One that can't run says why in
// place of what it does, whether it needs changing or an app keeps it from
// running (blocked.ts). A row's name and line stay on one line each.

type Row = {
  workflow: WorkflowInfo;
  group: string;
  // Where it sorts within its group: a time of day, else its name.
  order: string;
};

function triggersOf(workflow: WorkflowInfo) {
  return workflow.graph.nodes.filter((node) => node.kind === "trigger");
}

/** Whether every trigger is Run by hand, so Run is what starts it. */
export function byHand(workflow: WorkflowInfo, pieces: readonly PieceInfo[]) {
  const triggers = triggersOf(workflow);
  return (
    triggers.length > 0 &&
    triggers.every((node) => pieceOf(pieces, node)?.group === "By hand")
  );
}

/** What it does, in one line: its steps' sentences joined. */
export function stepsLine(
  workflow: WorkflowInfo,
  pieces: readonly PieceInfo[],
  names: Names,
) {
  return workflow.graph.nodes
    .filter((node) => node.kind === "step")
    .map((node, index) => {
      const piece = pieceOf(pieces, node);
      const text = piece ? plain(nodeParts(piece, node, names)) : node.piece;
      return index === 0 ? text : text.charAt(0).toLowerCase() + text.slice(1);
    })
    .join(", then ");
}

function rowsOf(
  workflows: readonly WorkflowInfo[],
  pieces: readonly PieceInfo[],
  names: Names,
): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const workflow of workflows) {
    const first = triggersOf(workflow)[0];
    const piece = first && pieceOf(pieces, first);
    const group = piece && first ? groupOf(piece, first, names) : "Other";
    const config = first?.config ?? {};
    const order =
      typeof config.time === "string"
        ? config.time
        : typeof config.event === "string"
          ? `${config.event === "sunrise" ? 0 : 1}${String(
              Number(config.offsetMinutes ?? 0) + 1000,
            ).padStart(5, "0")}`
          : workflow.name.toLocaleLowerCase();
    groups.set(group, [
      ...(groups.get(group) ?? []),
      { workflow, group, order },
    ]);
  }
  for (const rows of groups.values()) {
    rows.sort((a, b) => a.order.localeCompare(b.order));
  }
  return new Map([...groups].sort(([a], [b]) => compareGroups(a, b)));
}

export function AutomationsList(props: {
  automations: Automations;
  apps: readonly AppInfo[];
  names: Names;
  open(page: string, params?: Record<string, string>): void;
  now?: Date;
}) {
  const { workflows, pieces, problem, load } = props.automations;
  const [running, setRunning] = useState<string>();
  const [runProblem, setRunProblem] = useState<string>();
  const now = props.now ?? new Date();

  const run = async (workflow: WorkflowInfo) => {
    setRunning(workflow.id);
    setRunProblem(undefined);
    try {
      await props.automations.run(workflow.id);
    } catch (error) {
      setRunProblem(problemOf(error));
    } finally {
      setRunning(undefined);
    }
  };

  const bar = (
    <PageBar title="Automations">
      <PageBarButton
        primary
        icon={Plus}
        label="New automation"
        onClick={() => props.open("edit")}
      />
    </PageBar>
  );

  if (!workflows || !pieces) {
    return (
      <>
        {bar}
        {problem ? (
          <Card className="max-w-160 gap-3 px-5 py-4">
            <p role="alert" className="m-0 text-[15px] leading-[22px]">
              {problem}
            </p>
            <Button
              variant="outline"
              className="self-start"
              onClick={() => void load()}
            >
              Try again
            </Button>
          </Card>
        ) : (
          // Something at once while it loads: the shape of a list.
          <Card className="gap-1">
            {[0, 1, 2].map((each) => (
              <span
                key={each}
                aria-hidden="true"
                className="h-14 rounded-sm bg-foreground/4"
              />
            ))}
            <span className="sr-only">Loading automations</span>
          </Card>
        )}
      </>
    );
  }

  if (workflows.length === 0) {
    return (
      <>
        {bar}
        <Card className="max-w-160 gap-2.5 px-5.5 pt-5 pb-5.5">
          <p className="m-0 text-[15px] leading-[22px] font-medium">
            No automations yet
          </p>
          <p className="m-0 text-[15px] leading-[22px] text-muted-foreground">
            An automation does things for you: at a time, at sunrise or sunset,
            or when a device changes. It can also be one button that does
            several things at once. Make one with New automation; it reads like
            these:
          </p>
          <ul className="m-0 mt-1 flex list-none flex-col gap-2 p-0 text-[15px] leading-[22px]">
            <li>At sunset, turn on the lights in a room</li>
            <li>At 07:00 on weekdays, run a mood</li>
            <li>By hand: turn off every light in the home</li>
          </ul>
        </Card>
      </>
    );
  }

  // An app that isn't running keeps its automations from being next.
  const next = nextOf(
    workflows.filter((each) => !blockedBy(each, props.apps, pieces)),
  );
  const groups = rowsOf(workflows, pieces, props.names);
  return (
    <>
      {bar}
      {runProblem && (
        <p
          role="alert"
          className="m-0 text-[13px] leading-[18px] font-medium text-(--danger)"
        >
          {runProblem}
        </p>
      )}
      <div className="flex flex-col gap-6">
        {[...groups].map(([group, rows], index) => (
          <PageSection key={group} id={`automations-${index}`} title={group}>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {rows.map(({ workflow }) => (
                <AutomationRow
                  key={workflow.id}
                  workflow={workflow}
                  pieces={pieces}
                  apps={props.apps}
                  names={props.names}
                  now={now}
                  nextId={next?.id}
                  running={running === workflow.id}
                  onOpen={() => props.open("automation", { id: workflow.id })}
                  onRun={() => void run(workflow)}
                />
              ))}
            </ul>
          </PageSection>
        ))}
      </div>
      {next?.nextRun && (
        <p className="sr-only">
          Next: {next.name} at {timeWords(new Date(next.nextRun))}
        </p>
      )}
    </>
  );
}

function AutomationRow(props: {
  workflow: WorkflowInfo;
  pieces: readonly PieceInfo[];
  apps: readonly AppInfo[];
  names: Names;
  now: Date;
  nextId: string | undefined;
  running: boolean;
  onOpen(): void;
  onRun(): void;
}) {
  const { workflow, pieces, names } = props;
  const triggers = triggersOf(workflow);
  const first = triggers[0];
  const piece = first && pieceOf(pieces, first);
  const card = piece && first ? cardOf(piece, first, names) : undefined;
  const problem = workflow.problems[0];
  // What needs changing leads; then an app that keeps it from running.
  const blocked = problem ? null : blockedBy(workflow, props.apps, pieces);
  const status = blocked
    ? null
    : listStatus(workflow, { now: props.now, nextId: props.nextId });
  const runs = byHand(workflow, pieces);
  const stepIcons = workflow.graph.nodes
    .filter((node) => node.kind === "step")
    .slice(0, 3);
  return (
    <li className="flex min-w-0 items-center gap-1 rounded-sm hover:bg-foreground/5">
      <button
        type="button"
        onClick={props.onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-sm p-1.5 text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50 max-sm:flex-col max-sm:items-start max-sm:gap-1.5 max-sm:p-2"
      >
        <TriggerCard
          icon={
            <PieceIcon
              piece={piece}
              node={first}
              apps={props.apps}
              names={names}
            />
          }
          name={card?.name ?? "No trigger"}
          specifics={card?.specifics ?? null}
          more={triggers.length - 1}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 max-sm:w-full">
          <span
            className={`truncate text-[15px] leading-5 font-medium${
              workflow.enabled ? "" : " text-muted-foreground"
            }`}
          >
            {workflow.name}
          </span>
          {problem || blocked ? (
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-[18px] font-medium">
              <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">
                {problem
                  ? `Can't run: ${problem.message.charAt(0).toLowerCase()}${problem.message.slice(1)}`
                  : blockedLine(blocked!)}
              </span>
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-[18px] text-muted-foreground">
              {stepIcons.map((node) => (
                <PieceIcon
                  key={node.id}
                  piece={pieceOf(pieces, node)}
                  node={node}
                  apps={props.apps}
                  names={names}
                  size="small"
                />
              ))}
              <span className="truncate">
                {stepsLine(workflow, pieces, names)}
              </span>
            </span>
          )}
        </span>
        {status && !runs && (
          // A phone leaves the status out; the automation's page has it.
          <Status kind={status.kind} ink={status.ink} className="max-sm:hidden">
            {status.text}
          </Status>
        )}
      </button>
      {runs && (
        <Button
          variant="outline"
          size="sm"
          disabled={props.running || workflow.problems.length > 0 || !!blocked}
          onClick={props.onRun}
          aria-label={`Run ${workflow.name}`}
        >
          <Play aria-hidden="true" />
          {props.running ? "Running…" : "Run"}
        </Button>
      )}
      <ChevronRight
        aria-hidden="true"
        className="me-2.5 size-4 shrink-0 text-muted-foreground"
      />
    </li>
  );
}
