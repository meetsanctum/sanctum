import {
  controlPermission,
  entityReadPermission,
  placesReadPermission,
  readPermission,
  standardEntityTypes,
  workflowsManagePermission,
  type CapabilityKind,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowProblem,
} from "@meetsanctum/app-sdk";

import { deviceKinds, entityTypes } from "../app-host/calls.js";
import type { Devices } from "../devices/devices.js";
import type { View } from "../devices/views.js";
import { namedIn } from "./named.js";
import type { Pieces } from "./pieces.js";

// Workflows an app keeps act with the app's grants, not the household's:
// each of the core's pieces in one needs what the app would need to do the
// same itself, and every one needs workflows.manage. The core checks them
// when the app keeps a workflow, when one of its triggers matches and as
// each condition and step runs, reading devices as the app sees them. One
// its grants no longer cover is suspended until they do, never changed or
// deleted.

/** What an app holds, which the workflows it keeps act with. */
type Holding = { app: string; granted: readonly string[] };

// A device's capability, which a kept workflow's device piece must name.
type DeviceConfig = { device?: string; capability?: string };
type EntityConfig = { type?: string; app?: string };

// Why the app's grants do not cover a node, and the permission that would.
type Refused = { message: string; permission?: string };

export function createKeptGrants(options: {
  pieces: Pick<Pieces, "find" | "parse">;
  devices: Pick<Devices, "get">;
}) {
  const { pieces, devices } = options;

  // Why the app's grants do not cover one node, if they do not, with the
  // permission that would where one would. Its own pieces need nothing
  // more; another app's are refused when it keeps the workflow, and a node
  // the usual check refuses is left to that check.
  function refused(holding: Holding, node: WorkflowNode): Refused | undefined {
    const { app, granted } = holding;
    const missing = (permission: string) => ({
      message: `${app} does not hold ${permission}`,
      permission,
    });
    if (!granted.includes(workflowsManagePermission)) {
      return missing(workflowsManagePermission);
    }
    const piece = node.app ? undefined : pieces.find(node);
    const config = piece && pieces.parse<Record<string, unknown>>(node);
    if (piece?.app !== null || !config) {
      return undefined;
    }
    const { reads, controls } = deviceKinds(granted);
    const read = (kind: CapabilityKind) =>
      reads.has(kind) ? undefined : missing(readPermission(kind));
    const control = (kind: CapabilityKind) =>
      controls.has(kind) ? undefined : missing(controlPermission(kind));
    const hasNamedPlaces = namedIn(piece.config, node.config).some(
      (named) => named.kind === "room" || named.kind === "zone",
    );
    if (hasNamedPlaces && !granted.includes(placesReadPermission)) {
      return missing(placesReadPermission);
    }
    switch (`${node.kind}.${node.piece}`) {
      case "trigger.press":
        return read("button");
      case "trigger.motion":
      case "trigger.noMotion":
      case "condition.motion":
      case "condition.noMotion":
        return read("occupancy");
      case "condition.lightLevel":
        return read("sensor");
      case "condition.lights":
        return read("light");
      case "step.lights":
        return control("light");
      case "trigger.device":
      case "condition.device":
      case "step.device": {
        const { device, capability } = config as DeviceConfig;
        // A whole device would reach capabilities the app may not read.
        if (capability === undefined) {
          return {
            message: `${app}'s ${node.piece} ${node.kind} must name a capability`,
          };
        }
        // Capability ids are local to a device, not a kind: without the
        // device this trigger could match kinds the app may not read.
        if (device === undefined) {
          return {
            message: `${app}'s ${node.piece} ${node.kind} must name a device`,
          };
        }
        const kind = devices
          .get(device)
          ?.capabilities.find((each) => each.id === capability)?.kind;
        // Without its kind, what the app would need is unknown.
        if (!kind) {
          return {
            message: `${app}'s ${node.piece} ${node.kind} names a capability its device does not have`,
          };
        }
        return node.kind === "step" ? control(kind) : read(kind);
      }
      case "trigger.entity":
      case "condition.entity": {
        const { type, app: owner } = config as EntityConfig;
        if (owner === app) {
          return undefined;
        }
        // A type alone reaches every app's entities of it, so it must be a
        // standard type the app reads, as ctx.entities.list() needs.
        if (
          type === undefined ||
          !standardEntityTypes.some((standard) => standard.id === type)
        ) {
          return {
            message: `${app}'s entity ${node.kind} must name its own entity or a standard type it reads`,
          };
        }
        return entityTypes(granted).includes(type)
          ? undefined
          : missing(entityReadPermission(type));
      }
      default:
        // By hand, a time of day, the sun.
        return undefined;
    }
  }

  return {
    /** Why the app's grants do not cover one node, if they do not. */
    refusal(holding: Holding, node: WorkflowNode): string | undefined {
      return refused(holding, node)?.message;
    },

    /** Devices as the app sees them, which its workflows read. */
    view(holding: Holding): View {
      return { kinds: deviceKinds(holding.granted).reads };
    },

    /** What the app's grants keep a workflow it keeps from doing. */
    problems(holding: Holding, graph: WorkflowGraph): WorkflowProblem[] {
      const problems: WorkflowProblem[] = [];
      if (!holding.granted.includes(workflowsManagePermission)) {
        return [
          {
            node: null,
            field: null,
            message: `${holding.app} does not hold ${workflowsManagePermission}`,
            permission: workflowsManagePermission,
          },
        ];
      }
      for (const node of graph.nodes) {
        const refusal = refused(holding, node);
        if (refusal) {
          problems.push({ node: node.id, field: null, ...refusal });
        }
      }
      return problems;
    },
  };
}
