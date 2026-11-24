import type { WorkflowNode } from "@meetsanctum/app-sdk";

import type { EmittedEvent } from "../app-host/app-work.js";
import type { DeviceChange } from "../devices/devices.js";
import { placeKey, type MotionChange } from "../devices/motion.js";
import type { Press } from "../devices/presses.js";
import type { EntityChange } from "../entities/entities.js";
import type { Engine, WorkflowRow } from "./engine.js";
import { changeFires, sameValue, statePasses } from "./graph.js";
import { comparedState } from "./media.js";
import type {
  DeviceTriggerConfig,
  EntityTriggerConfig,
  MotionTriggerConfig,
  NoMotionTriggerConfig,
  PressTriggerConfig,
} from "./core-pieces.js";
import type { Pieces } from "./pieces.js";
import type { Timers } from "./timers.js";

// What starts a workflow other than a timer or Run: an app's event, a
// device's change, motion in a place, a remote's press and an app's entity
// changing, each matched against the triggers of the workflows that may run.
// A workflow an app keeps runs only while the app runs and its grants cover
// it: not while the app is absent or paused, or the workflow suspended
// (kept-grants.ts). A place's motion, as Motion keeps it, starts motion
// triggers as the place goes from no motion to motion, once, however many
// sensors see it, and sets no-motion triggers' timers (timers.ts). A device
// trigger that asks for its change to hold (forSeconds) waits that long in
// memory, and lets it go if the device changes back before: a wait of
// seconds that a restart forgets, as the change it waited on is forgotten.

export function createFiring(options: {
  rows: () => WorkflowRow[];
  pieces: Pieces;
  engine: Pick<Engine, "fire">;
  // Whether a workflow's triggers may start it now.
  mayRun: (workflow: WorkflowRow) => boolean;
  timers: Pick<Timers, "quiet">;
}) {
  const { pieces, engine } = options;
  const parsed = <T>(node: WorkflowNode) => pieces.parse<T>(node);

  // Device triggers waiting for their change to hold, by workflow, node,
  // device and capability.
  type Hold = {
    timer: ReturnType<typeof setTimeout>;
    device: string;
    capability: string;
    config: DeviceTriggerConfig;
  };
  const holds = new Map<string, Hold>();

  function letGo(key: string) {
    clearTimeout(holds.get(key)?.timer);
    holds.delete(key);
  }

  // A held trigger fires as its wait ends, if its workflow may still run
  // and still has the trigger as it was.
  function hold(
    workflow: WorkflowRow,
    node: WorkflowNode,
    config: DeviceTriggerConfig & { forSeconds: number },
    data: Record<string, unknown> & { device: string; capability: string },
  ) {
    const key = [workflow.id, node.id, data.device, data.capability].join(
      "\u0000",
    );
    if (holds.has(key)) {
      return;
    }
    const timer = setTimeout(() => {
      holds.delete(key);
      const now = options.rows().find((each) => each.id === workflow.id);
      const same = now?.graph.nodes.find((each) => each.id === node.id);
      if (
        !now?.enabled ||
        !options.mayRun(now) ||
        !same ||
        same.app ||
        same.piece !== "device" ||
        !sameValue(parsed(same), config)
      ) {
        return;
      }
      engine.fire(now, { nodes: [node.id], key: null, data });
    }, config.forSeconds * 1000);
    holds.set(key, {
      timer,
      device: data.device,
      capability: data.capability,
      config,
    });
  }

  // Each running workflow's trigger nodes that a firing matches.
  function matching(
    match: (workflow: WorkflowRow, node: WorkflowNode) => boolean,
  ) {
    return options.rows().flatMap((workflow) => {
      if (!workflow.enabled || !options.mayRun(workflow)) {
        return [];
      }
      const nodes = workflow.graph.nodes.filter(
        (node) => node.kind === "trigger" && match(workflow, node),
      );
      return nodes.length > 0 ? [{ workflow, nodes }] : [];
    });
  }

  // A place's motion changed (motion.ts): its no-motion triggers' timers
  // follow it, and its motion triggers fire as it goes from no motion to
  // motion, once, however many sensors see it, when a sensor's own report
  // made it. A sensor moved or a change of the places fires nothing, since
  // nobody moved.
  function motionChanged({ places, sensedBy }: MotionChange) {
    const changes = new Map(
      places.map((change) => [placeKey(change.place), change]),
    );
    const fired = matching((workflow, node) => {
      if (node.app || (node.piece !== "motion" && node.piece !== "noMotion")) {
        return false;
      }
      if (node.piece === "noMotion") {
        const config = parsed<NoMotionTriggerConfig>(node);
        const change = config && changes.get(placeKey(config.place));
        if (change) {
          options.timers.quiet(workflow, node, change.after, config.forMinutes);
        }
        return false;
      }
      const config = parsed<MotionTriggerConfig>(node);
      const change = config && changes.get(placeKey(config.place));
      return (
        change !== undefined &&
        sensedBy !== null &&
        !change.before.motion &&
        change.after.motion
      );
    });
    for (const { workflow, nodes } of fired) {
      engine.fire(workflow, {
        nodes: nodes.map((node) => node.id),
        key: null,
        data: { device: sensedBy, motion: true },
      });
    }
  }

  return {
    /**
     * An event an app emitted: it starts at most one run of each workflow
     * whose triggers match it, by the fields their configs set.
     */
    appEvent(event: EmittedEvent) {
      const fired = matching((_workflow, node) => {
        if (node.app !== event.app) {
          return false;
        }
        const piece = pieces.find(node);
        if (!piece || piece.app === null || piece.kind !== "trigger") {
          return false;
        }
        const config = parsed<Record<string, unknown>>(node);
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        return (
          piece.trigger.event === event.event &&
          config !== undefined &&
          Object.entries(config).every(
            ([field, value]) =>
              value === undefined || sameValue(value, payload[field]),
          )
        );
      });
      for (const { workflow, nodes } of fired) {
        engine.fire(workflow, {
          nodes: nodes.map((node) => node.id),
          key: `event:${event.id}`,
          data: { event: event.event, payload: event.payload },
        });
      }
    },

    /**
     * A device's change: `device` triggers compare what each capability
     * reported before and after.
     */
    deviceChanged(change: DeviceChange) {
      const after = change.after;
      const id = (after ?? change.before)?.id;
      // A change undone lets the triggers waiting on it go: a device gone,
      // or a state that no longer passes.
      for (const [key, held] of holds) {
        if (held.device !== id) {
          continue;
        }
        const capability = after?.capabilities.find(
          (each) => each.id === held.capability,
        );
        if (
          !capability ||
          !statePasses(
            held.config,
            comparedState(capability.kind, capability.observed),
          )
        ) {
          letGo(key);
        }
      }
      if (!after) {
        return;
      }
      const changed = after.capabilities.flatMap((capability) => {
        const before =
          change.before?.capabilities.find((each) => each.id === capability.id)
            ?.observed ?? null;
        return sameValue(before, capability.observed)
          ? []
          : [{ capability, before }];
      });
      if (changed.length === 0) {
        return;
      }
      const seen = new Map<string, (typeof changed)[number]>();
      const fired = matching((workflow, node) => {
        if (node.app || node.piece !== "device") {
          return false;
        }
        const config = parsed<DeviceTriggerConfig>(node);
        if (!config || (config.device && config.device !== after.id)) {
          return false;
        }
        const hit = changed.find(
          ({ capability, before }) =>
            (!config.capability || config.capability === capability.id) &&
            (!config.kind || config.kind === capability.kind) &&
            changeFires(
              config,
              comparedState(capability.kind, before),
              comparedState(capability.kind, capability.observed),
            ),
        );
        if (hit && config.forSeconds !== undefined) {
          hold(
            workflow,
            node,
            config as typeof config & { forSeconds: number },
            {
              device: after.id,
              capability: hit.capability.id,
              kind: hit.capability.kind,
              before: hit.before,
              after: hit.capability.observed,
            },
          );
          return false;
        }
        if (hit && !seen.has(workflow.id)) {
          seen.set(workflow.id, hit);
        }
        return hit !== undefined;
      });
      for (const { workflow, nodes } of fired) {
        const { capability, before } = seen.get(workflow.id)!;
        engine.fire(workflow, {
          nodes: nodes.map((node) => node.id),
          key: null,
          data: {
            device: after.id,
            capability: capability.id,
            kind: capability.kind,
            before,
            after: capability.observed,
          },
        });
      }
    },

    /**
     * A remote's press, which no capture holds: it starts at most one run
     * of each workflow with a `press` trigger for that remote and action,
     * once for each press.
     */
    pressed(press: Pick<Press, "id" | "device" | "capability" | "action">) {
      const { device, capability, action } = press;
      const fired = matching((_workflow, node) => {
        if (node.app || node.piece !== "press") {
          return false;
        }
        const config = parsed<PressTriggerConfig>(node);
        return (
          config !== undefined &&
          config.device === device.id &&
          (!config.capability || config.capability === capability) &&
          (!config.action || config.action === action)
        );
      });
      for (const { workflow, nodes } of fired) {
        engine.fire(workflow, {
          nodes: nodes.map((node) => node.id),
          key: `press:${press.id}`,
          data: { device: device.id, capability, action },
        });
      }
    },

    motionChanged,

    /** Lets every held trigger go, as workflows stop. */
    stop() {
      for (const key of [...holds.keys()]) {
        letGo(key);
      }
    },

    /**
     * An app's entity changed: `entity` triggers compare its state before
     * and after by the rules of `device` triggers. One that went fires
     * nothing, and a key that changed type is a new entity of its new type.
     */
    entityChanged(change: EntityChange) {
      const { app, key, after } = change;
      if (!after) {
        return;
      }
      const { type } = after;
      const before = change.before?.type === type ? change.before.state : null;
      const fired = matching((_workflow, node) => {
        if (node.app || node.piece !== "entity") {
          return false;
        }
        const config = parsed<EntityTriggerConfig>(node);
        return (
          config !== undefined &&
          (!config.type || config.type === type) &&
          (!config.app || config.app === app) &&
          (!config.key || config.key === key) &&
          changeFires(config, before, after.state)
        );
      });
      for (const { workflow, nodes } of fired) {
        engine.fire(workflow, {
          nodes: nodes.map((node) => node.id),
          key: null,
          data: { type, app, key, before, after: after.state },
        });
      }
    },
  };
}
