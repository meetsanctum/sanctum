import type {
  StateOperator,
  WorkflowGraph,
  WorkflowNode,
} from "@meetsanctum/app-sdk";

// A workflow's graph: which steps a run reaches from the triggers that
// fired, through which conditions, and how a state field is compared.

export type StepPlan = {
  step: WorkflowNode;
  /**
   * Whether a path of edges from the fired triggers reaches the step with
   * every condition on it passing. It asks `passes` about each condition it
   * meets, following the edges in the graph's order, and stops at the first
   * path that passes.
   */
  reached(
    passes: (condition: WorkflowNode) => Promise<boolean>,
  ): Promise<boolean>;
};

// The graph's edges, both ways. A path ends at the step it reaches, so no
// edge leads on from a step.
function edgesOf(graph: WorkflowGraph) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const next = new Map<string, string[]>();
  const previous = new Map<string, string[]>();
  for (const { from, to } of graph.edges) {
    const kind = nodeById.get(from)?.kind;
    if (!nodeById.has(to) || (kind !== "trigger" && kind !== "condition")) {
      continue;
    }
    next.set(from, [...(next.get(from) ?? []), to]);
    previous.set(to, [...(previous.get(to) ?? []), from]);
  }
  return { nodeById, next, previous };
}

// The nodes some path leads from to `stepId`, the step included.
function leadingTo(previous: Map<string, string[]>, stepId: string) {
  const found = new Set([stepId]);
  const waiting = [stepId];
  while (waiting.length > 0) {
    for (const from of previous.get(waiting.pop()!) ?? []) {
      if (!found.has(from)) {
        found.add(from);
        waiting.push(from);
      }
    }
  }
  return found;
}

/**
 * The steps a run from these triggers may reach, in the graph's order.
 * Whether each runs is found as the run gets to it, so a condition is
 * checked after the steps before it have run. Each search visits a node
 * once at most, as a condition passes or not whatever path met it, so
 * its work grows with the graph's size, not with the number of paths
 * through it.
 */
export function executionPlan(
  graph: WorkflowGraph,
  triggerIds: ReadonlySet<string>,
): StepPlan[] {
  const { nodeById, next, previous } = edgesOf(graph);
  return graph.nodes.flatMap((step) => {
    if (step.kind !== "step") {
      return [];
    }
    const within = leadingTo(previous, step.id);
    const starts = [...triggerIds].filter((id) => within.has(id));
    if (starts.length === 0) {
      return [];
    }
    return [
      {
        step,
        async reached(passes) {
          const seen = new Set<string>();
          const visit = async (id: string): Promise<boolean> => {
            const node = nodeById.get(id);
            if (!node || seen.has(id) || !within.has(id)) {
              return false;
            }
            seen.add(id);
            if (id === step.id) {
              return true;
            }
            if (node.kind === "condition" && !(await passes(node))) {
              return false;
            }
            for (const to of next.get(id) ?? []) {
              if (await visit(to)) {
                return true;
              }
            }
            return false;
          };
          for (const id of starts) {
            if (await visit(id)) {
              return true;
            }
          }
          return false;
        },
      } satisfies StepPlan,
    ];
  });
}

/** Whether any trigger leads to any step. */
export function hasTriggerToStepPath(graph: WorkflowGraph) {
  const { nodeById, next } = edgesOf(graph);
  const seen = new Set<string>();
  const waiting = graph.nodes
    .filter((node) => node.kind === "trigger")
    .map((node) => node.id);
  while (waiting.length > 0) {
    const id = waiting.pop()!;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (nodeById.get(id)?.kind === "step") {
      return true;
    }
    waiting.push(...(next.get(id) ?? []));
  }
  return false;
}

/** A field of a state, such as "on" or "color.hue"; a "state." prefix is allowed. */
export function stateField(state: unknown, field: string) {
  let current: unknown = state;
  for (const segment of field.replace(/^state\./, "").split(".")) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Whether a value passes an operator; no operator passes anything. */
export function passes(
  value: unknown,
  operator: StateOperator | undefined,
  expected: unknown,
) {
  switch (operator) {
    case undefined:
      return true;
    case "is_on":
      return value === true;
    case "is_off":
      return value === false;
    case "not_equals":
      return !Object.is(value, expected);
    case "equals":
      return Object.is(value, expected);
    case "below":
      return (
        typeof value === "number" &&
        typeof expected === "number" &&
        value < expected
      );
    case "above":
      return (
        typeof value === "number" &&
        typeof expected === "number" &&
        value > expected
      );
  }
}

// Below and above fire as a value crosses its threshold, not on every
// reading past it: a light level reported every few seconds under 30 lx
// would fire each time.
const crossing = (operator: StateOperator | undefined) =>
  operator === "below" || operator === "above";

export type StatePredicate = {
  field?: string;
  operator?: StateOperator;
  value?: unknown;
};

/**
 * Whether a change from `before` to `after` fires a trigger. With a field:
 * it changed and its new value passes, or there was no state before and it
 * passes; below and above pass only as the value crosses into them. Without
 * one: anything changed.
 */
export function changeFires(
  predicate: StatePredicate,
  before: unknown,
  after: unknown,
) {
  if (after === null || after === undefined) {
    return false;
  }
  if (!predicate.field) {
    return before === null || before === undefined
      ? true
      : !sameValue(before, after);
  }
  const current = stateField(after, predicate.field);
  if (current === undefined) {
    return false;
  }
  if (before === null || before === undefined) {
    return passes(current, predicate.operator, predicate.value);
  }
  const previous = stateField(before, predicate.field);
  if (crossing(predicate.operator)) {
    return (
      passes(current, predicate.operator, predicate.value) &&
      !passes(previous, predicate.operator, predicate.value)
    );
  }
  return (
    !sameValue(previous, current) &&
    passes(current, predicate.operator, predicate.value)
  );
}

/** Whether a state passes a condition now. */
export function statePasses(predicate: StatePredicate, state: unknown) {
  if (!predicate.field) {
    return false;
  }
  const value = stateField(state, predicate.field);
  return (
    value !== undefined && passes(value, predicate.operator, predicate.value)
  );
}

/** Whether two JSON values are the same, objects compared by their fields. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) =>
    sameValue(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
    ),
  );
}
