import type {
  AppInfo,
  PieceInfo,
  PieceKind,
  RunMode,
  WorkflowInfo,
  WorkflowNode,
  WorkflowProblem,
} from "@meetsanctum/app-sdk";
import { Button, Card, Input, PageBar, PageSection } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import {
  ChevronDown,
  CircleAlert,
  EllipsisVertical,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { CoreError } from "../core-fetch";
import { Chooser, deviceKindsFor, withDevice, type NewNode } from "./chooser";
import { pieceOf, problemOf, type Automations } from "./data";
import { FieldControl, type Home } from "./fields";
import { autoName, graphOf, isSimple, needsValue } from "./graph";
import { PieceIcon, Sentence } from "./parts";
import {
  capitalize,
  fieldKind,
  fieldsOf,
  nodeParts,
  type Names,
  type Part,
} from "./words";

// The editor: cards that read as sentences under When, And and Then, each
// value a token pressed to change it in place, and one primary button that
// moves along as it is built: Add a trigger, then Add a step, then Save in
// the top bar, which says what it waits for. A new automation is named after
// what starts it until someone names it.

type Draft = {
  name: string;
  enabled: boolean;
  runMode: RunMode;
  nodes: WorkflowNode[];
};

const groups = [
  {
    kind: "trigger",
    title: "When",
    hint: "what starts it",
    add: "Add a trigger",
  },
  {
    kind: "condition",
    title: "And",
    hint: "only if these are true · optional",
    add: "Add a condition",
  },
  {
    kind: "step",
    title: "Then",
    hint: "what it does, in order",
    add: "Add a step",
  },
] as const;

const runModes: { mode: RunMode; label: string }[] = [
  { mode: "single", label: "Skip the new run" },
  { mode: "restart", label: "Stop it and start again" },
  { mode: "queued", label: "Run it after this one" },
  { mode: "parallel", label: "Run both at once" },
];

function draftOf(workflow: WorkflowInfo | undefined): Draft {
  return workflow
    ? {
        name: workflow.name,
        enabled: workflow.enabled,
        runMode: workflow.runMode,
        nodes: graphOf(workflow.graph.nodes).nodes,
      }
    : { name: "", enabled: true, runMode: "single", nodes: [] };
}

function newId(kind: PieceKind) {
  return `${kind}-${crypto.randomUUID().slice(0, 8)}`;
}

function changeField(
  piece: PieceInfo,
  node: WorkflowNode,
  home: Home,
  name: string,
  value: unknown,
) {
  const field = fieldsOf(piece.config)[name] ?? {};
  const config = { ...node.config, [name]: value };
  const device =
    field.names === "device"
      ? home.devices.find((each) => each.id === value)
      : undefined;
  return device ? withDevice(piece, config, device) : config;
}

export function EditorPage(props: {
  id: string | undefined;
  automations: Automations;
  apps: readonly AppInfo[];
  home: Home;
  names: Names;
  back(): void;
  /** Asks for some of an app's optional permissions, for a piece that needs them. */
  ask(app: string, permissions: readonly string[]): Promise<boolean>;
}) {
  const { workflows, pieces } = props.automations;
  const workflow = props.id
    ? workflows?.find((each) => each.id === props.id)
    : undefined;
  const loading = props.id !== undefined && workflows === undefined;
  const initial = useMemo(() => draftOf(workflow), [workflow]);
  const [edited, setEdited] = useState<Draft>();
  const draft = edited ?? initial;
  const [adding, setAdding] = useState<PieceKind | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  // The core's problems, as saved or as a failed save answered.
  const [answered, setProblems] = useState<WorkflowProblem[]>();
  const problems = answered ?? workflow?.problems ?? [];
  const [deleting, setDeleting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [allOptions, setAllOptions] = useState<string>();

  if (loading || !pieces) return <PageBar title="Edit automation" />;
  if (props.id && !workflow) {
    return (
      <>
        <PageBar title="Edit automation">
          <Button variant="outline" onClick={props.back}>
            Done
          </Button>
        </PageBar>
        <p className="m-0 text-[15px]">
          That automation is gone. It may have been deleted elsewhere.
        </p>
      </>
    );
  }
  // One an app keeps, or of a shape this editor doesn't save, reads only.
  const readOnly = workflow
    ? workflow.app !== null || !isSimple(workflow.graph)
    : false;

  const change = (next: Partial<Draft>) => setEdited({ ...draft, ...next });
  const setNodes = (nodes: WorkflowNode[]) => change({ nodes });
  const nodesOf = (kind: PieceKind) =>
    draft.nodes.filter((node) => node.kind === kind);
  const nodeProblems = (node: WorkflowNode) =>
    problems.filter((each) => each.node === node.id);
  const missing = draft.nodes.filter((node) =>
    needsValue(pieceOf(pieces, node), node, props.names, nodeProblems(node)),
  ).length;
  const hasTrigger = nodesOf("trigger").length > 0;
  const hasStep = nodesOf("step").length > 0;
  const waitsFor =
    !hasTrigger && !hasStep
      ? "Add a trigger and a step to save"
      : !hasTrigger
        ? "Add a trigger to save"
        : !hasStep
          ? "Add a step to save"
          : missing > 0
            ? `Fill in ${missing === 1 ? "1 card" : `${missing} cards`} to save`
            : undefined;
  const automatic = autoName(draft.nodes, pieces, props.names);
  const dirty =
    edited !== undefined && JSON.stringify(edited) !== JSON.stringify(initial);

  const save = async () => {
    setSaving(true);
    setProblem(undefined);
    const name = draft.name.trim() || automatic || "New automation";
    const graph = graphOf(draft.nodes);
    try {
      if (workflow) {
        await props.automations.update({
          id: workflow.id,
          name,
          runMode: draft.runMode,
          graph,
        });
      } else {
        await props.automations.add({
          name,
          enabled: draft.enabled,
          runMode: draft.runMode,
          graph,
        });
      }
      props.back();
    } catch (error) {
      setProblem(problemOf(error));
      // The core's problems mark the cards they are about.
      if (error instanceof CoreError && error.code === "invalid_workflow") {
        const body = error.body as { problems?: WorkflowProblem[] } | null;
        setProblems(Array.isArray(body?.problems) ? body.problems : []);
      }
    } finally {
      setSaving(false);
    }
  };

  const updateNode = (node: WorkflowNode, config: Record<string, unknown>) => {
    setNodes(
      draft.nodes.map((each) =>
        each.id === node.id ? { ...each, config } : each,
      ),
    );
    // A changed value answers the problem it had.
    setProblems(problems.filter((each) => each.node !== node.id));
  };
  const move = (node: WorkflowNode, by: -1 | 1) => {
    const same = nodesOf(node.kind);
    const at = same.findIndex((each) => each.id === node.id);
    const other = same[at + by];
    if (!other) return;
    setNodes(
      draft.nodes.map((each) =>
        each.id === node.id ? other : each.id === other.id ? node : each,
      ),
    );
  };
  // A piece that needs one of its app's optional permissions that is off
  // asks for it first, once Add has closed, and goes in only once allowed.
  const add = async (picked: NewNode) => {
    const piece = pieceOf(pieces, picked);
    const app = props.apps.find((each) => each.id === piece?.app);
    const off = (app ? (piece?.needs ?? []) : []).filter(
      (id) => !app!.permissions.includes(id),
    );
    setAdding(null);
    if (app && off.length > 0 && !(await props.ask(app.id, off))) return;
    const node = { ...picked, id: newId(picked.kind) } as WorkflowNode;
    setNodes([...draft.nodes, node]);
  };

  const title = workflow ? "Edit automation" : "New automation";
  const option = draft.nodes.find((node) => node.id === allOptions);
  const optionPiece = option && pieceOf(pieces, option);

  return (
    <>
      <PageBar title={title}>
        {waitsFor && !readOnly && (
          <span className="flex items-center gap-1.5 text-[13px] leading-[18px] font-medium text-muted-foreground max-sm:hidden">
            {missing > 0 && hasTrigger && hasStep && (
              <CircleAlert aria-hidden="true" className="size-3.5" />
            )}
            {waitsFor}
          </span>
        )}
        <Button
          variant="outline"
          onClick={() => (dirty ? setDiscarding(true) : props.back())}
        >
          Cancel
        </Button>
        <Button
          disabled={saving || readOnly || waitsFor !== undefined}
          onClick={() => void save()}
          aria-describedby={waitsFor ? "save-waits" : undefined}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </PageBar>
      <div className="flex max-w-160 flex-col gap-6">
        {waitsFor && !readOnly && (
          <p
            id="save-waits"
            className={cn(
              "m-0 flex items-center gap-1.5 text-[13px] leading-[18px] font-medium sm:sr-only",
              missing > 0 ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {waitsFor}
          </p>
        )}
        {readOnly && (
          <Card className="flex-row items-center gap-3 px-4 py-3.5">
            <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
            <span className="text-[15px] leading-5">
              {workflow?.app
                ? `${props.names.app(workflow.app) ?? workflow.app} keeps this automation, so it's changed there.`
                : "This automation was made another way, so it can be read here but not changed."}
            </span>
          </Card>
        )}
        {problem && (
          <p
            role="alert"
            className="m-0 text-[13px] leading-[18px] font-medium text-(--danger)"
          >
            {problem}
          </p>
        )}
        <PageSection id="editor-name" title="Name">
          <Input
            aria-label="Name"
            value={draft.name}
            disabled={readOnly}
            placeholder={
              automatic ?? "Named after what it does, until you name it"
            }
            maxLength={120}
            onChange={(event) => change({ name: event.target.value })}
            className="m-1 w-auto bg-background"
          />
        </PageSection>
        {groups.map((group) => {
          const list = nodesOf(group.kind);
          const primary =
            !readOnly &&
            ((group.kind === "trigger" && !hasTrigger) ||
              (group.kind === "step" && hasTrigger && !hasStep));
          return (
            <PageSection
              key={group.kind}
              id={`editor-${group.kind}`}
              title={group.title}
              hint={list.length === 0 ? group.hint : undefined}
            >
              {list.map((node, index) => {
                const piece = pieceOf(pieces, node);
                return (
                  <div key={node.id} className="flex flex-col">
                    {group.kind === "step" && index > 0 && (
                      <span className="ps-12.5 text-[13px] leading-4 font-medium text-muted-foreground">
                        then
                      </span>
                    )}
                    <NodeCard
                      node={node}
                      piece={piece}
                      apps={props.apps}
                      home={props.home}
                      names={props.names}
                      problems={nodeProblems(node)}
                      readOnly={readOnly}
                      first={index === 0}
                      last={index === list.length - 1}
                      onChange={(config) => updateNode(node, config)}
                      onMove={(by) => move(node, by)}
                      onRemove={() =>
                        setNodes(
                          draft.nodes.filter((each) => each.id !== node.id),
                        )
                      }
                      onAllOptions={() => setAllOptions(node.id)}
                    />
                  </div>
                );
              })}
              {!readOnly && (
                <div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
                  <Button
                    size="sm"
                    variant={primary ? "default" : "outline"}
                    onClick={() => setAdding(group.kind)}
                  >
                    <Plus aria-hidden="true" />
                    {group.add}
                  </Button>
                  {group.kind === "step" && (
                    // Try would run the draft's steps once without saving;
                    // it is disabled.
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled
                        aria-describedby="try-later"
                      >
                        <Play aria-hidden="true" />
                        Try the steps
                      </Button>
                      <span
                        id="try-later"
                        className="text-[13px] leading-[18px] font-medium text-muted-foreground"
                      >
                        Not available in this version
                      </span>
                    </>
                  )}
                </div>
              )}
            </PageSection>
          );
        })}
        <PageSection
          id="editor-run-mode"
          title="If it starts again while it's still running"
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={readOnly}>
              <Button
                variant="outline"
                type="button"
                className="m-1 justify-between"
              >
                {runModes.find((each) => each.mode === draft.runMode)?.label}
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup
                value={draft.runMode}
                onValueChange={(mode) => change({ runMode: mode as RunMode })}
              >
                {runModes.map((each) => (
                  <DropdownMenuRadioItem key={each.mode} value={each.mode}>
                    {each.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </PageSection>
        {workflow && workflow.app === null && (
          <div>
            <Button
              variant="ghost"
              className="-ms-2.5"
              onClick={() => setDeleting(true)}
            >
              <Trash2 aria-hidden="true" />
              Delete automation
            </Button>
          </div>
        )}
      </div>
      <Chooser
        kind={adding}
        pieces={pieces}
        home={props.home}
        apps={props.apps}
        names={props.names}
        onPick={(picked) => void add(picked)}
        onClose={() => setAdding(null)}
      />
      <Dialog
        open={option !== undefined}
        onOpenChange={(open) => !open && setAllOptions(undefined)}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{optionPiece?.title ?? "All options"}</DialogTitle>
            <DialogDescription>
              Every value this card can have, those its sentence leaves out too.
            </DialogDescription>
          </DialogHeader>
          {option && optionPiece && (
            <div className="flex max-h-[60dvh] flex-col gap-4 overflow-y-auto">
              {Object.entries(fieldsOf(optionPiece.config)).map(
                ([name, field]) => (
                  <div key={name} className="flex flex-col gap-1.5">
                    <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
                      {String(field.title ?? capitalize(name))}
                    </span>
                    <FieldControl
                      name={name}
                      field={field}
                      value={option.config[name]}
                      context={{
                        home: props.home,
                        config: option.config,
                        deviceKinds: deviceKindsFor(optionPiece, option.config),
                      }}
                      onChange={(value) =>
                        updateNode(
                          option,
                          changeField(
                            optionPiece,
                            option,
                            props.home,
                            name,
                            value,
                          ),
                        )
                      }
                    />
                  </div>
                ),
              )}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setAllOptions(undefined)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete {workflow?.name}?</DialogTitle>
            <DialogDescription>
              It stops running, and its history goes with it. This can't be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                try {
                  await props.automations.remove(workflow!.id);
                  setDeleting(false);
                  props.back();
                } catch (error) {
                  setDeleting(false);
                  setProblem(problemOf(error));
                }
              }}
            >
              Delete automation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={discarding} onOpenChange={setDiscarding}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Discard your changes?</DialogTitle>
            <DialogDescription>
              What you changed here isn't saved yet.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscarding(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={props.back}>
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function NodeCard(props: {
  node: WorkflowNode;
  piece: PieceInfo | undefined;
  apps: readonly AppInfo[];
  home: Home;
  names: Names;
  problems: WorkflowProblem[];
  readOnly: boolean;
  first: boolean;
  last: boolean;
  onChange(config: Record<string, unknown>): void;
  onMove(by: -1 | 1): void;
  onRemove(): void;
  onAllOptions(): void;
}) {
  const { node, piece } = props;
  const marked = new Set(
    props.problems.flatMap((each) =>
      each.field ? [each.field.split(".")[0]] : [],
    ),
  );
  const parts: Part[] = piece
    ? nodeParts(piece, node, props.names).map((part) =>
        typeof part !== "string" && marked.has(part.field)
          ? { ...part, missing: true }
          : part,
      )
    : [`${node.piece} is gone`];
  const label = parts
    .map((part) => (typeof part === "string" ? part : part.text))
    .join("");
  return (
    <div className="flex items-start gap-3 rounded-sm py-1.5 ps-2.5 pe-1">
      <span className="mt-0.5">
        <PieceIcon
          piece={piece}
          node={node}
          apps={props.apps}
          names={props.names}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Sentence
          parts={parts}
          token={
            piece && !props.readOnly
              ? (part) => (
                  <Token
                    part={part}
                    piece={piece}
                    node={node}
                    home={props.home}
                    onChange={props.onChange}
                  />
                )
              : undefined
          }
        />
        {props.problems.map((problem) => (
          <span
            key={problem.message}
            className="flex items-center gap-1.5 text-[13px] leading-[18px] font-medium"
          >
            <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            {problem.message}
          </span>
        ))}
      </span>
      {!props.readOnly && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${label}: more`}
            >
              <EllipsisVertical aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {piece && (
              <DropdownMenuItem onSelect={props.onAllOptions}>
                All options
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              disabled={props.first}
              onSelect={() => props.onMove(-1)}
            >
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={props.last}
              onSelect={() => props.onMove(1)}
            >
              Move down
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={props.onRemove}>
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

// A value in a sentence, pressed to change it in a popover beside it.
function Token(props: {
  part: Exclude<Part, string>;
  piece: PieceInfo;
  node: WorkflowNode;
  home: Home;
  onChange(config: Record<string, unknown>): void;
}) {
  const [open, setOpen] = useState(false);
  const { part, piece, node } = props;
  const field = fieldsOf(piece.config)[part.field] ?? {};
  const set = (value: unknown) => {
    const kind = fieldKind(field);
    props.onChange(changeField(piece, node, props.home, part.field, value));
    // A pick from a list is the answer; the rest stay open to adjust.
    if (
      ["names", "place", "choice", "entityOf", "options", "boolean"].includes(
        kind.kind,
      )
    ) {
      setOpen(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "mx-px inline-flex h-7 items-center rounded-sm border border-transparent px-2 align-baseline text-[15px] leading-[22px] font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            part.missing && !open
              ? "border-dashed border-muted-foreground"
              : "bg-foreground/12",
            open && "bg-foreground text-background",
          )}
        >
          {part.text}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-90 max-w-[calc(100vw-2rem)] gap-3 p-3.5"
      >
        <FieldControl
          name={part.field}
          field={field}
          value={node.config[part.field]}
          context={{
            home: props.home,
            config: node.config,
            deviceKinds: deviceKindsFor(piece, node.config),
          }}
          onChange={set}
        />
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
