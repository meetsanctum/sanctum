import {
  capabilityOf,
  householdTiers,
  standardEntityTypes,
  type PieceInfo,
  type PieceKind,
  type PieceWords,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowProblem,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import type {
  Checked,
  DeclaredPiece,
  DeclaredTrigger,
  JsonSchema,
} from "../app-host/contract.js";
import type { AppHost } from "../app-host/host.js";
import type { Devices } from "../devices/devices.js";
import type { Entities } from "../entities/entities.js";
import type { PlacesModule } from "../places/places.js";
import {
  corePieces,
  type CorePiece,
  type DeviceStepConfig,
  type EntityTriggerConfig,
  type PressTriggerConfig,
} from "./core-pieces.js";
import { hasTriggerToStepPath } from "./graph.js";
import { namedIn, namedInSchema, type Named } from "./named.js";

// The pieces a workflow is built from: the core's own (core-pieces.ts) and
// those each installed app provides. A graph is checked against them when it
// is saved and again before each run, since an app can go or change in
// between, and so can the rooms, zones, devices and entities its configs
// name.

/** A node's piece, found. */
export type Piece =
  | { app: null; kind: PieceKind; id: string; title: string; config: z.ZodType }
  | {
      app: string;
      kind: "trigger";
      id: string;
      title: string;
      schema: JsonSchema;
      trigger: DeclaredTrigger;
    }
  | {
      app: string;
      kind: "condition" | "step";
      id: string;
      title: string;
      schema: JsonSchema;
      action: DeclaredPiece;
    };

export type Check = {
  // Why it cannot be saved or run, each tied to its node and the field of
  // its config when there is one.
  problems: WorkflowProblem[];
  // What it may not do on its own.
  warnings: string[];
};

function jsonSchema(schema: z.ZodType) {
  try {
    return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  } catch {
    return {};
  }
}

function safeParse(schema: z.ZodType, value: unknown) {
  try {
    return schema.safeParse(value);
  } catch {
    return undefined;
  }
}

// A node's config against its piece: the core's own schema, or the JSON Schema
// in an app's manifest. What it parses to is what the piece acts on.
function checkConfig(piece: Piece, value: unknown): Checked | undefined {
  if (piece.app !== null) {
    return piece.kind === "trigger"
      ? piece.trigger.config(value)
      : piece.action.input(value);
  }
  const parsed = safeParse(piece.config, value);
  if (!parsed) return undefined;
  return parsed.success
    ? { success: true, data: parsed.data }
    : {
        success: false,
        issues: parsed.error.issues.map(({ path, message }) => ({
          path: path.map((part) =>
            typeof part === "number" ? part : String(part),
          ),
          message,
        })),
      };
}

// What a node's config names, by its piece's schema.
function namedBy(piece: Piece, config: unknown): Named[] {
  return piece.app === null
    ? namedIn(piece.config, config)
    : namedInSchema(piece.schema, config);
}

// The client shows a problem as it is, so each is a sentence: schemas'
// own messages, such as "use a time such as 07:30", start with a capital.
const sentence = (message: string) =>
  message.charAt(0).toUpperCase() + message.slice(1);

const pathOf = (path: readonly PropertyKey[]) =>
  path.length > 0 ? path.map(String).join(".") : null;

/** What a piece says in the editor's list, from its words. */
function wordsOf(words: PieceWords | undefined) {
  return {
    sentence: words?.sentence ?? null,
    card: words?.card
      ? { name: words.card.name, specifics: words.card.specifics ?? null }
      : null,
    presets: [...(words?.presets ?? [])],
    icon: words?.icon ?? null,
  };
}

/** Why a set of problems keeps a run from starting, for its history. */
export function problemsReason(problems: readonly WorkflowProblem[]) {
  return problems.map((problem) => problem.message).join(". ");
}

export function createPieces(options: {
  host: Pick<AppHost, "has" | "pieces" | "list">;
  devices: Pick<Devices, "get">;
  places: Pick<PlacesModule, "hasRoom" | "hasZone">;
  entities: Pick<Entities, "get" | "list">;
  // Whether an app provides sun times now.
  hasSun: () => boolean;
}) {
  const { host } = options;

  function find(node: Pick<WorkflowNode, "kind" | "app" | "piece">) {
    if (!node.app) {
      const own = (corePieces[node.kind] as Record<string, CorePiece>)[
        node.piece
      ];
      return own && Object.hasOwn(corePieces[node.kind], node.piece)
        ? ({
            app: null,
            kind: node.kind,
            id: node.piece,
            title: own.title,
            config: own.config,
          } satisfies Piece)
        : undefined;
    }
    const pieces = host.pieces().find((each) => each.app === node.app);
    if (!pieces) {
      return undefined;
    }
    if (node.kind === "trigger") {
      const trigger = pieces.triggers.get(node.piece);
      return trigger
        ? ({
            app: node.app,
            kind: "trigger",
            id: trigger.id,
            title: trigger.title,
            schema: trigger.schema,
            trigger,
          } satisfies Piece)
        : undefined;
    }
    const action = (
      node.kind === "condition" ? pieces.conditions : pieces.steps
    ).get(node.piece);
    return action
      ? ({
          app: node.app,
          kind: node.kind,
          id: action.id,
          title: action.title,
          schema: action.schema,
          action,
        } satisfies Piece)
      : undefined;
  }

  // Whether the room, zone, device or entity a config names is still there.
  function exists(named: Named) {
    switch (named.kind) {
      case "device":
        return options.devices.get(named.id) !== null;
      case "room":
        return options.places.hasRoom(named.id);
      case "zone":
        return options.places.hasZone(named.id);
      case "entity":
        return options.entities
          .list({ type: named.type })
          .some(({ key }) => key === named.id);
    }
  }

  // An entity type's name, as a sentence says it, while an app brings it.
  function entityWord(type: string | undefined) {
    const title = [
      ...standardEntityTypes,
      ...host.list().flatMap((app) => app.provides.entities),
    ].find(({ id }) => id === type)?.title;
    return title?.toLowerCase() ?? "item";
  }

  // What a node's config names that is not there, at the field that names
  // it: one it never was, when the workflow is saved, and later one that
  // was removed, which never comes back under its id.
  function namedProblems(
    node: WorkflowNode,
    piece: Piece,
    saving: boolean,
  ): WorkflowProblem[] {
    const gone = new Map<string, Named>();
    for (const each of namedBy(piece, node.config)) {
      // An app may keep a workflow in its start before it has published what it
      // names, so only one that's gone counts for an entity.
      if (each.kind === "entity" && saving) continue;
      if (!exists(each)) {
        gone.set(`${each.field}\u0000${each.kind}\u0000${each.id}`, each);
      }
    }
    return [...gone.values()].map((each) => ({
      node: node.id,
      field: each.field || null,
      message: saving
        ? `There is no ${each.kind} ${each.id}`
        : `The ${each.kind === "entity" ? entityWord(each.type) : each.kind} it names was removed`,
    }));
  }

  // A device step's command, for the capability of the device it names,
  // when the workflow is saved.
  function deviceStepProblems(
    node: WorkflowNode,
    config: DeviceStepConfig,
  ): WorkflowProblem[] {
    const device = options.devices.get(config.device);
    const capability = device?.capabilities.find(
      (each) => each.id === config.capability,
    );
    if (!capability) {
      return [
        {
          node: node.id,
          field: "capability",
          message: `There is no device ${config.device} with ${config.capability}`,
        },
      ];
    }
    const command = capabilityOf(capability.kind).command.safeParse(
      config.command,
    );
    return command.success
      ? []
      : command.error.issues.map((issue) => ({
          node: node.id,
          field: pathOf(["command", ...issue.path]),
          message: `The command does not fit a ${capability.kind}: ${issue.message.charAt(0).toLowerCase()}${issue.message.slice(1)}`,
        }));
  }

  // A press trigger's remote and action, when the workflow is saved.
  function pressTriggerProblem(
    node: WorkflowNode,
    config: PressTriggerConfig,
  ): WorkflowProblem | undefined {
    const device = options.devices.get(config.device);
    const buttons = device?.capabilities.filter(
      (each) =>
        each.kind === "button" &&
        (config.capability === undefined || each.id === config.capability),
    );
    if (!buttons?.length) {
      return {
        node: node.id,
        field: config.capability === undefined ? "device" : "capability",
        message: `There is no device ${config.device} with a button${config.capability ? ` ${config.capability}` : ""}`,
      };
    }
    const { action } = config;
    return action === undefined ||
      buttons.some(
        (button) =>
          button.kind === "button" && button.features.actions.includes(action),
      )
      ? undefined
      : {
          node: node.id,
          field: "action",
          message: `${device!.name} has no action ${action}`,
        };
  }

  // Whether an installed app brings entities of a type now.
  function brought(type: string) {
    return host
      .list()
      .some((app) => app.provides.entities.some((each) => each.id === type));
  }

  // An entity piece's type, which must be a standard one or one an
  // installed app brings when the workflow is saved. An app's own type
  // that goes later, or a standard one no app brings, waits for one.
  function entityTypeCheck(
    type: string | undefined,
    saving: boolean,
  ): { problem?: string; warning?: string } {
    if (type === undefined || brought(type)) {
      return {};
    }
    return saving && !standardEntityTypes.some((each) => each.id === type)
      ? { problem: `There is no entity type ${type}` }
      : { warning: `${type} waits for an app that brings it` };
  }

  return {
    find,

    /** The config of a node of the core's own, already known to fit. */
    coreConfig(node: WorkflowNode): unknown {
      const piece = find(node);
      return piece?.app === null ? piece.config.parse(node.config) : undefined;
    },

    /**
     * A node's config as its piece parses it, which is what the piece acts
     * on; none when the piece is gone or the config no longer fits.
     */
    parse<T>(node: WorkflowNode): T | undefined {
      const piece = find(node);
      const result = piece && checkConfig(piece, node.config);
      return result?.success ? (result.data as T) : undefined;
    },

    /**
     * Every piece a workflow may use now, with its config as JSON Schema
     * and the words Automations reads it with.
     */
    list(): PieceInfo[] {
      const own = (Object.keys(corePieces) as PieceKind[]).flatMap((kind) =>
        Object.entries(corePieces[kind] as Record<string, CorePiece>).map(
          ([piece, { title, config, words, group }]) => ({
            kind,
            app: null,
            id: piece,
            title,
            config: jsonSchema(config),
            ...wordsOf(words),
            // The core's own pieces need only the household's access.
            needs: [],
            group: group ?? null,
          }),
        ),
      );
      const apps = host.pieces().flatMap((pieces) => [
        ...[...pieces.triggers.values()].map((trigger) => ({
          kind: "trigger" as const,
          app: pieces.app,
          id: trigger.id,
          title: trigger.title,
          config: trigger.schema,
          ...wordsOf(trigger.words ?? undefined),
          // The client shows the app's icon for its pieces.
          icon: null,
          needs: [...(trigger.needs ?? [])],
          group: null,
        })),
        ...(["condition", "step"] as const).flatMap((kind) =>
          [
            ...(kind === "condition"
              ? pieces.conditions
              : pieces.steps
            ).values(),
          ].map((action) => ({
            kind,
            app: pieces.app,
            id: action.id,
            title: action.title,
            config: action.schema,
            ...wordsOf(action.words ?? undefined),
            icon: null,
            needs: [...(action.needs ?? [])],
            group: null,
          })),
        ),
      ]);
      return [...own, ...apps];
    },

    /** What a graph's nodes name, by the fields their pieces declare. */
    named(graph: WorkflowGraph): Named[] {
      return graph.nodes.flatMap((node) => {
        const piece = find(node);
        return piece ? namedBy(piece, node.config) : [];
      });
    },

    /**
     * What keeps a graph from being saved or from running (v1's
     * validateAutomationGraph), and what it may not do on its own: a room,
     * zone, device or entity it names that is gone among them. Saving also checks
     * the commands its device steps send.
     */
    check(graph: WorkflowGraph, options_: { saving?: boolean } = {}): Check {
      const saving = options_.saving ?? false;
      const problems: WorkflowProblem[] = [];
      const warnings: string[] = [];
      const ids = new Set<string>();
      for (const node of graph.nodes) {
        if (ids.has(node.id)) {
          problems.push({
            node: node.id,
            field: null,
            message: `Two nodes are called ${node.id}`,
          });
        }
        ids.add(node.id);
      }
      for (const edge of graph.edges) {
        for (const end of [edge.from, edge.to]) {
          if (!ids.has(end)) {
            problems.push({
              node: null,
              field: null,
              message: `An edge leads to ${end}, which is not a node`,
            });
          }
        }
      }
      for (const node of graph.nodes) {
        const piece = find(node);
        if (!piece) {
          problems.push({
            node: node.id,
            field: null,
            message:
              node.app && !host.has(node.app)
                ? `The app ${node.app} is not installed, for ${node.piece}`
                : `${node.app ? `The app ${node.app}` : "The core"} has no ${node.kind} ${node.piece}`,
          });
          continue;
        }
        const config = checkConfig(piece, node.config);
        if (!config?.success) {
          problems.push(
            ...(config
              ? config.issues.map((issue) => ({
                  node: node.id,
                  field: pathOf(issue.path),
                  message: sentence(issue.message),
                }))
              : [{ node: node.id, field: null, message: "Its schema failed" }]),
          );
          continue;
        }
        const named = namedProblems(node, piece, saving);
        if (named.length > 0) {
          problems.push(...named);
          continue;
        }
        if (
          piece.app === null &&
          node.kind === "step" &&
          piece.id === "device" &&
          saving
        ) {
          problems.push(
            ...deviceStepProblems(node, config.data as DeviceStepConfig),
          );
        }
        if (
          piece.app === null &&
          node.kind === "trigger" &&
          piece.id === "press" &&
          saving
        ) {
          const problem = pressTriggerProblem(
            node,
            config.data as PressTriggerConfig,
          );
          if (problem) {
            problems.push(problem);
          }
        }
        if (piece.app === null && piece.id === "entity") {
          const { type, app, key } = config.data as EntityTriggerConfig;
          const { problem, warning } = entityTypeCheck(type, saving);
          if (problem) {
            problems.push({ node: node.id, field: "type", message: problem });
          }
          if (!saving && app !== undefined && key !== undefined) {
            const entity = options.entities.get(app, key);
            if (
              entity === null ||
              (type !== undefined && entity.type !== type)
            ) {
              problems.push({
                node: node.id,
                field: "key",
                message: `The ${entityWord(type)} it names was removed`,
              });
            }
          }
          if (warning) {
            warnings.push(`${node.piece}: ${warning}`);
          }
        }
        if (
          piece.app === null &&
          node.kind === "trigger" &&
          piece.id === "sun"
        ) {
          if (!options.hasSun()) {
            warnings.push(
              "Sunrise and sunset wait for an app that knows the sun, such as Weather",
            );
          }
        }
        if (
          piece.app !== null &&
          piece.kind === "step" &&
          !householdTiers.includes(piece.action.tier)
        ) {
          warnings.push(
            `${piece.id} needs a person's approval each time, so a workflow can't run it`,
          );
        }
      }
      const has = (kind: PieceKind) =>
        graph.nodes.some((node) => node.kind === kind);
      const whole = (message: string) =>
        problems.push({ node: null, field: null, message });
      if (!has("trigger")) {
        whole("A workflow needs a trigger");
      }
      if (!has("step")) {
        whole("A workflow needs a step");
      }
      if (has("trigger") && has("step") && !hasTriggerToStepPath(graph)) {
        whole("No trigger leads to a step");
      }
      return { problems, warnings: [...new Set(warnings)] };
    },
  };
}

export type Pieces = ReturnType<typeof createPieces>;
