import type { WorkflowNode } from "@meetsanctum/app-sdk";

import type { AppEvent } from "../app-host/host.js";
import type { DeviceChange } from "../devices/devices.js";
import type { Motion } from "../devices/motion.js";
import type { Press } from "../devices/presses.js";
import type { EntityChange } from "../entities/entities.js";
import type { Engine, WorkflowRow } from "./engine.js";
import { changeFires, sameValue } from "./graph.js";
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
// (kept-grants.ts). A place's motion starts motion triggers as the place
// goes from no motion to motion, once, however many sensors see it, and
// sets no-motion triggers' timers (timers.ts).

export function createFiring(options: {
  rows: () => WorkflowRow[];
  pieces: Pieces;
  engine: Pick<Engine, "fire">;
  // Whether a workflow's triggers may start it now.
  mayRun: (workflow: WorkflowRow) => boolean;
  // Motion in a place before and after a device's change.
  motion: Pick<Motion, "around">;
  timers: Pick<Timers, "quiet">;
}) {
  const { pieces, engine } = options;
  const parsed = <T>(node: WorkflowNode) => pieces.parse<T>(node);

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

  // A motion sensor's change, its going offline or back, or its leaving:
  // whether its places' motion triggers fire, and their no-motion timers.
  function motionChanged(change: DeviceChange) {
    const senses = (device: DeviceChange["before"]) =>
      device?.capabilities.some((each) => each.kind === "occupancy") ?? false;
    if (!senses(change.before) && !senses(change.after)) {
      return;
    }
    const fired = matching((workflow, node) => {
      if (node.app || (node.piece !== "motion" && node.piece !== "noMotion")) {
        return false;
      }
      if (node.piece === "noMotion") {
        const config = parsed<NoMotionTriggerConfig>(node);
        if (config) {
          const { was, now } = options.motion.around(config.place, change);
          // Reports and settings that leave the quiet spell unchanged
          // must not clear a due timer before the next tick runs it.
          if (
            was.answering !== now.answering ||
            was.occupied !== now.occupied ||
            was.quietSince?.getTime() !== now.quietSince?.getTime()
          ) {
            options.timers.quiet(workflow, node, now, config.forMinutes);
          }
        }
        return false;
      }
      const config = parsed<MotionTriggerConfig>(node);
      if (!config) {
        return false;
      }
      const { was, now } = options.motion.around(config.place, change);
      return !was.occupied && now.occupied;
    });
    for (const { workflow, nodes } of fired) {
      engine.fire(workflow, {
        nodes: nodes.map((node) => node.id),
        key: null,
        data: { device: change.id, motion: true },
      });
    }
  }

  return {
    /**
     * An event an app emitted: it starts at most one run of each workflow
     * whose triggers match it, by the fields their configs set.
     */
    appEvent(event: AppEvent) {
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
      motionChanged(change);
      const after = change.after;
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
            changeFires(config, before, capability.observed),
        );
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
