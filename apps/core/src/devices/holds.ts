import type {
  Actor,
  CapabilityInfo,
  DeviceInfo,
  DriverMove,
  LightMove,
} from "@meetsanctum/app-sdk";

import type { Outcome } from "../activity/schema.js";
import { ActionCallError } from "../app-host/errors.js";
import type { Gate } from "../app-host/gate.js";
import type { Devices } from "./devices.js";
import type { Press } from "./presses.js";
import type { StoredSetBy } from "./schema.js";
import type { View } from "./views.js";

// A remote's held button brightening or dimming lights. The lights step
// starts a dim of a place's lights, tied to the remote's press that ran its
// workflow, and each light's driver moves its brightness by itself
// (driver.move): a hold costs a light one message to start and one to stop,
// however long it lasts. A dim ends when the remote's button is let go
// (ctx.devices.release), when the remote is pressed again, when anything
// else commands the light, and in any case after six seconds, by when every
// light has reached its end. Dims live in memory, so a restart ends them and
// their lights stay where they got to. A dim never switches a light off:
// brightening one that is off turns it on at its lowest first, through
// Devices like any command, and dimming leaves one that is off alone and
// stops at the lowest. A light says where it got to a moment after its stop,
// so a step that goes from a light's level waits for that (settle).

/** The remote's press a dim follows. */
export type Remote = {
  id: string;
  device: string;
  capability: string;
  action: string;
};

/** Up, down, or each hold the other way from the last (by turns). */
export type HoldDirection = "up" | "down" | "turns";

type Light = {
  device: DeviceInfo;
  capability: Extract<CapabilityInfo, { kind: "light" }>;
};

type Dim = {
  remote: Remote;
  actor: Actor;
  driver: string;
  key: string;
  ready: Promise<void>;
  hasMoved: boolean;
  isEnded: boolean;
};

/** How long a dim lasts at most when its release is lost (v1's 6 s). */
export const holdLimitMs = 6_000;
/** From the lowest to full in four seconds, as Hue's own dimmer goes. */
export const holdPercentPerSecond = 25;
/**
 * How long a light a dim stopped has to say where it got to: Zigbee2MQTT
 * reads one back half a second after its stop.
 */
export const holdSettleMs = 1_000;
// The directions held by turns that the core remembers, oldest dropped.
const rememberedTurns = 200;

const lightKey = (device: string, capability: string) =>
  `${device}/${capability}`;
const remoteKey = (remote: Remote) =>
  `${remote.device}/${remote.capability}/${remote.action}`;

const isOn = (light: Light) => light.capability.state?.on === true;

// Its brightness as shown, which is what the core last asked for while a
// command is on its way.
function levelOf({ capability }: Light) {
  if (capability.kind !== "light" || capability.state?.on !== true) return 0;
  return capability.state.brightness ?? 100;
}

const canDim = (light: Light) =>
  light.capability.kind === "light" && light.capability.features.brightness;

export function createHolds(options: {
  devices: Pick<Devices, "command" | "row" | "moving" | "moved">;
  gate: Pick<Gate, "permit">;
  // Hands a move to the driver app that brings the light.
  move: (driver: string, move: DriverMove, actor: Actor) => Promise<void>;
  // Whether a driver can move its lights (driver.move).
  canMove: (driver: string) => boolean;
  // The activity log: a hold's move with which way it went, and its stop
  // only when it fails, since a stop is part of the same hold.
  record: (entry: {
    action: string;
    outcome: Outcome;
    reason?: string;
    actor?: string;
    subjectId?: string;
    detail?: Record<string, unknown>;
  }) => void;
  limitMs?: number;
  settleMs?: number;
  now?: () => Date;
}) {
  const { devices } = options;
  const now = options.now ?? (() => new Date());
  const limitMs = options.limitMs ?? holdLimitMs;
  const settleMs = options.settleMs ?? holdSettleMs;
  const dims = new Map<string, Dim>();
  const held = new Map<string, Remote & { timer: NodeJS.Timeout }>();
  let isClosed = false;

  const isHeld = (remote: Remote) =>
    !isClosed && held.get(remote.device)?.id === remote.id;
  // Stops on their way, which a new move of the light waits for, and the
  // lights stopped that have yet to say where they got to.
  const stopping = new Map<string, Promise<void>>();
  const settling = new Map<string, Promise<void>>();
  const turns = new Map<string, "up" | "down">();

  function log(
    actor: Actor,
    target: { device: string; capability: string },
    move: LightMove,
    outcome: Outcome,
    reason?: string,
  ) {
    options.record({
      action: "device.command",
      outcome,
      reason,
      actor: `${actor.kind}:${actor.id}`,
      subjectId: target.device,
      detail: { capability: target.capability, move: move.move },
    });
  }

  async function deliver(
    actor: Actor,
    target: { driver: string; key: string; device: string; capability: string },
    move: LightMove,
  ) {
    const { driver, ...rest } = target;
    try {
      await options.move(driver, { ...rest, move }, actor);
    } catch (error) {
      const failure =
        error instanceof ActionCallError
          ? error
          : new ActionCallError("app_failed");
      log(
        actor,
        target,
        move,
        failure.status >= 500 ? "failed" : "refused",
        failure.code,
      );
      throw failure;
    }
    if (move.move !== "stop") log(actor, target, move, "ok");
  }

  // Ends a light's dim with a stop, which the light answers with where it
  // got to; one that fails leaves the light where it got to anyway.
  function end(key: string) {
    const dim = dims.get(key);
    if (!dim) return stopping.get(key);
    dims.delete(key);
    dim.isEnded = true;
    const [device, capability] = key.split("/") as [string, string];
    const stop = dim.ready
      .then(async () => {
        if (!dim.hasMoved) return;
        await deliver(
          dim.actor,
          { driver: dim.driver, key: dim.key, device, capability },
          { move: "stop" },
        );
        settleAfter(key);
      })
      .catch(() => undefined)
      .finally(() => {
        if (stopping.get(key) === stop) stopping.delete(key);
      });
    stopping.set(key, stop);
    return stop;
  }

  // A light just stopped has settleMs to say where it got to.
  function settleAfter(key: string) {
    const settled: Promise<void> = new Promise<void>((resolve) => {
      setTimeout(resolve, settleMs).unref();
    }).finally(() => {
      if (settling.get(key) === settled) settling.delete(key);
    });
    settling.set(key, settled);
  }

  function endWhere(matches: (remote: Remote) => boolean) {
    for (const [key, dim] of dims) {
      if (matches(dim.remote)) void end(key);
    }
  }

  // By turns starts from the shown brightness, then follows its previous
  // direction. Reports after a stop can lag behind a quick second hold.
  function turnOf(remote: Remote, lights: readonly Light[]): "up" | "down" {
    const lit = lights.filter(isOn);
    if (lit.length === 0) return "up";
    const last = turns.get(remoteKey(remote));
    if (last !== undefined) return last === "up" ? "down" : "up";
    return Math.max(...lit.map(levelOf)) < 50 ? "up" : "down";
  }

  function remember(remote: Remote, direction: "up" | "down") {
    const key = remoteKey(remote);
    turns.delete(key);
    turns.set(key, direction);
    if (turns.size > rememberedTurns) {
      turns.delete(turns.keys().next().value!);
    }
  }

  // Sets one light moving, turning it on at its lowest first when it is
  // off and brightens; whether it moved.
  async function startOne(
    actor: Actor,
    remote: Remote,
    light: Light,
    direction: "up" | "down",
    view: View,
  ) {
    const { device, capability } = light;
    const key = lightKey(device.id, capability.id);
    // A moving light's last report may still be at an endpoint. Let the
    // driver clamp there, rather than ignoring a hold that reverses it.
    if (direction === "down" && !isOn(light)) return false;
    const row = devices.row(device.id);
    if (!row) throw new ActionCallError("not_found");
    options.gate.permit(actor, { tier: "write" });
    if (!isHeld(remote)) return false;
    const previous = end(key);
    // Devices checks beforeCommand synchronously. Start the wake command
    // before registering this move so it interrupts only the previous dim.
    const waking = !isOn(light)
      ? devices.command(
          actor,
          {
            device: device.id,
            capability: capability.id,
            command: { on: true, brightness: 1 },
          },
          view,
          null,
        )
      : undefined;
    let ready!: () => void;
    const starting = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const dim: Dim = {
      remote,
      actor,
      driver: row.driver,
      key: row.key,
      ready: starting,
      hasMoved: false,
      isEnded: false,
    };
    dims.set(key, dim);
    try {
      await Promise.all([previous, waking]);
      if (dim.isEnded || !isHeld(remote)) return false;
      // Even a driver failure can follow a delivered move. End it as well.
      dim.hasMoved = true;
      // The move is newer than the wake and any command before it: none of
      // them goes again while the light moves (commands.ts).
      devices.moving(device.id, capability.id);
      await deliver(
        actor,
        {
          driver: row.driver,
          key: row.key,
          device: device.id,
          capability: capability.id,
        },
        { move: direction, percentPerSecond: holdPercentPerSecond },
      );
      const setBy: StoredSetBy = {
        app: null,
        actor,
        asked: { brightness: direction === "up" ? 100 : 1 },
        at: now().toISOString(),
      };
      devices.moved(device.id, capability.id, setBy);
      return true;
    } catch (error) {
      if (dims.get(key) === dim) void end(key);
      throw error;
    } finally {
      ready();
      if (!isHeld(remote) && dims.get(key) === dim) void end(key);
    }
  }

  return {
    /**
     * Brightens or dims lights while the remote's button that ran the
     * workflow is held: the lights that can dim and whose driver can move
     * them. Names the lights it set moving and those that failed.
     */
    async start(
      actor: Actor,
      remote: Remote,
      lights: readonly Light[],
      direction: HoldDirection,
      view: View,
    ) {
      if (!isHeld(remote)) {
        return {
          direction: "up" as const,
          moved: [],
          failed: [],
          on: lights.some(isOn),
        };
      }
      const movable = lights.filter(
        (light) => canDim(light) && options.canMove(light.device.driver),
      );
      const way = direction === "turns" ? turnOf(remote, movable) : direction;
      if (direction === "turns") remember(remote, way);
      const results = await Promise.allSettled(
        movable.map((light) => startOne(actor, remote, light, way, view)),
      );
      const moved: Light[] = [];
      const failed: { light: Light; reason: unknown }[] = [];
      for (const [index, result] of results.entries()) {
        const light = movable[index]!;
        if (result.status === "rejected") {
          failed.push({ light, reason: result.reason });
        } else if (result.value) {
          moved.push(light);
        }
      }
      const on = lights.some(isOn) || (way === "up" && moved.length > 0);
      return { direction: way, moved, failed, on };
    },

    /** The remote's button was let go: its dims end. */
    released(device: string, capability: string) {
      const press = held.get(device);
      if (press?.capability === capability) {
        clearTimeout(press.timer);
        held.delete(device);
      }
      endWhere(
        (remote) =>
          remote.device === device && remote.capability === capability,
      );
    },

    /** The remote was pressed again, which ends any dim it left going. */
    pressed(press: Press) {
      const device = press.device.id;
      const previous = held.get(device);
      if (previous) clearTimeout(previous.timer);
      held.delete(device);
      endWhere((remote) => remote.device === device);
      const button = press.device.capabilities.find(
        (each) => each.id === press.capability && each.kind === "button",
      );
      if (
        isClosed ||
        press.isCaptured ||
        button?.kind !== "button" ||
        !button.features.holds.includes(press.action)
      )
        return;
      const timer = setTimeout(() => {
        held.delete(device);
        endWhere((remote) => remote.device === device);
      }, limitMs);
      timer.unref();
      held.set(device, {
        id: press.id,
        device,
        capability: press.capability,
        action: press.action,
        timer,
      });
    },

    /**
     * Something else commands the light: its dim ends first. Nothing to
     * wait for while it is not moving.
     */
    interrupt(device: string, capability: string) {
      return end(lightKey(device, capability));
    },

    /**
     * Waits for the lights a dim has moving or has just stopped to say
     * where they got to, ending a dim first, so a step goes from there.
     */
    async settle(
      lights: readonly { device: { id: string }; capability: { id: string } }[],
    ) {
      await Promise.all(
        lights.map(async ({ device, capability }) => {
          const key = lightKey(device.id, capability.id);
          await end(key);
          await settling.get(key);
        }),
      );
    },

    /** Whether a light is moving now, as tests ask. */
    isMoving(device: string, capability: string) {
      return dims.has(lightKey(device, capability));
    },

    async close() {
      isClosed = true;
      for (const press of held.values()) clearTimeout(press.timer);
      held.clear();
      for (const key of dims.keys()) void end(key);
      await Promise.all(stopping.values());
      turns.clear();
    },
  };
}

export type Holds = ReturnType<typeof createHolds>;
