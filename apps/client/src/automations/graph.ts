import type {
  PieceInfo,
  WorkflowGraph,
  WorkflowNode,
  WorkflowProblem,
} from "@meetsanctum/app-sdk";

import { pieceOf } from "./data";
import {
  fieldsOf,
  formatValue,
  nodeParts,
  plain,
  requiredOf,
  type Names,
} from "./words";

// How Automations saves a workflow: a simple graph, in which every trigger
// leads to the first condition, each condition to the next, and the last to
// every step, or every trigger to every step when there are no conditions.
// Nodes keep that order, since steps run in the graph's order. A graph of
// another shape, made through the API, opens read only rather than being
// reshaped.

const kindOrder = ["trigger", "condition", "step"] as const;

export function graphOf(nodes: readonly WorkflowNode[]): WorkflowGraph {
  const of = (kind: WorkflowNode["kind"]) =>
    nodes.filter((node) => node.kind === kind);
  const triggers = of("trigger");
  const conditions = of("condition");
  const steps = of("step");
  const edges: WorkflowGraph["edges"] = [];
  if (conditions.length > 0) {
    for (const trigger of triggers) {
      edges.push({ from: trigger.id, to: conditions[0]!.id });
    }
    conditions
      .slice(1)
      .forEach((condition, index) =>
        edges.push({ from: conditions[index]!.id, to: condition.id }),
      );
    for (const step of steps) {
      edges.push({ from: conditions.at(-1)!.id, to: step.id });
    }
  } else {
    for (const trigger of triggers) {
      for (const step of steps) edges.push({ from: trigger.id, to: step.id });
    }
  }
  return {
    version: 1,
    nodes: kindOrder.flatMap((kind) => of(kind)),
    edges,
  };
}

/** Whether a saved graph has the shape the editor saves. */
export function isSimple(graph: WorkflowGraph) {
  const rebuilt = graphOf(graph.nodes);
  const key = (edge: { from: string; to: string }) =>
    `${edge.from}\u0000${edge.to}`;
  const edges = new Set(graph.edges.map(key));
  return (
    rebuilt.nodes.every((node, index) => node.id === graph.nodes[index]?.id) &&
    rebuilt.edges.length === edges.size &&
    rebuilt.edges.every((edge) => edges.has(key(edge)))
  );
}

/**
 * Whether a node still needs a value: a required field not set, or one
 * naming what the home no longer has.
 */
export function needsValue(
  piece: PieceInfo | undefined,
  node: WorkflowNode,
  names: Names,
  problems: readonly WorkflowProblem[] = [],
) {
  if (!piece) return true;
  if (problems.some((problem) => problem.node === node.id)) return true;
  const fields = fieldsOf(piece.config);
  const unset = requiredOf(piece.config).some(
    (name) =>
      node.config[name] === undefined && fields[name]?.default === undefined,
  );
  return (
    unset ||
    nodeParts(piece, node, names).some(
      (part) => typeof part !== "string" && part.missing,
    ) ||
    Object.entries(node.config).some(
      ([name, value]) =>
        value !== undefined &&
        fields[name] !== undefined &&
        (fields[name]!.names !== undefined || fields[name]!.place === true) &&
        formatValue(fields[name]!, value, names, "sentence") === undefined,
    )
  );
}

/** The name an automation goes by until someone names it. */
export function autoName(
  nodes: readonly WorkflowNode[],
  pieces: readonly PieceInfo[] | undefined,
  names: Names,
) {
  const trigger = nodes.find((node) => node.kind === "trigger");
  const piece = trigger && pieceOf(pieces, trigger);
  if (!trigger || !piece) return undefined;
  const words = plain(nodeParts(piece, trigger, names))
    .split(",")[0]!
    .trim();
  return words.length > 120 ? `${words.slice(0, 119)}…` : words;
}
