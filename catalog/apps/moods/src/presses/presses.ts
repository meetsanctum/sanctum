import {
  controlPermission,
  placesReadPermission,
  pressParts,
  readPermission,
  workflowsManagePermission,
  type AppContext,
  type DeviceInfo,
  type KeptWorkflowRequest,
  type Places,
  type WorkflowGraph,
} from "@meetsanctum/app-sdk";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { presses } from "../moods/schema.js";
import { readMoods } from "../moods/store.js";

// What each press of a remote does: the household chooses on the remote's
// Presses page, Moods keeps the choice, and from it a workflow from the
// core's press trigger to the core's lights step or Moods' own runMood. A
// choice of lights is a room, a zone, the whole home or chosen lights, as
// v1's button bindings chose them (toggle_lights' entity targets), and what
// to do with them: switch them, step them brighter or dimmer, or brighten or
// dim them while a hold lasts. Each press a remote in a room has no choice
// for keeps its default, in one workflow for all of them: a remote with up
// and down buttons is a dimmer for its room, and any other press switches
// the room's lights on or off, as v1's default toggle did, with a hold
// brightening or dimming them by turns. Moods works the workflows out again
// whenever the choices, a remote, its room, a place, a light, a mood or its
// permissions change, and only then puts or removes them. Presses pause
// while Moods may not read remotes, their lights or the home's places: their
// workflows go and the choices stay, since losing sight of something is not
// losing it. Without its own automations it can change none of them, so it
// leaves them all as they are.

type Db = AppContext["storage"]["db"];

const id = z.string().min(1).max(64);

/** Which lights a press is for: a room's, a zone's, the whole home's, or chosen ones. */
export const pressPlace = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("room"), id }),
  z.object({ kind: z.literal("zone"), id }),
  z.object({ kind: z.literal("home") }),
  z.object({
    kind: z.literal("lights"),
    lights: z
      .array(z.object({ device: id, capability: id }))
      .min(1)
      .max(200),
  }),
]);
export type PressPlace = z.output<typeof pressPlace>;

// What a press does to its lights, as the core's lights step takes it; the
// last three only while a hold lasts.
export const pressTo = z.enum([
  "on",
  "toggle",
  "off",
  "brighter",
  "dimmer",
  "brightenWhileHeld",
  "dimWhileHeld",
  "brightenOrDimWhileHeld",
]);
export type PressTo = z.output<typeof pressTo>;

/** What a press does only while a hold lasts. */
export const whileHeld: ReadonlySet<PressTo> = new Set([
  "brightenWhileHeld",
  "dimWhileHeld",
  "brightenOrDimWhileHeld",
]);

/** What one press does: nothing, something to lights, or a mood. */
export const pressChoice = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("nothing") }),
  z.object({ kind: z.literal("lights"), place: pressPlace, to: pressTo }),
  z.object({ kind: z.literal("mood"), moodId: id }),
]);
export type PressChoice = z.output<typeof pressChoice>;

/** A remote's button, with the presses and holds its driver declares. */
export function buttonOf(device: DeviceInfo) {
  const buttons = device.capabilities.filter((each) => each.kind === "button");
  const button = buttons[0];
  return (
    button && {
      ...button,
      features: {
        actions: [...new Set(buttons.flatMap((each) => each.features.actions))],
        holds: [...new Set(buttons.flatMap((each) => each.features.holds))],
      },
    }
  );
}

type Button = NonNullable<ReturnType<typeof buttonOf>>;

const endsWith = (word: string) => new RegExp(`(?:^|_)${word}$`, "i");

/** Whether a remote has up and down buttons, as a dimmer switch does. */
export function isDimmer(button: Button) {
  const buttons = button.features.actions.map(
    (action) => pressParts(action).button ?? "",
  );
  return (
    buttons.some((each) => endsWith("up").test(each)) &&
    buttons.some((each) => endsWith("down").test(each))
  );
}

/**
 * What a press does until the household chooses, for a remote in a room: a
 * dimmer's on and off buttons switch the room's lights, its up and down
 * buttons step them, and holding them brightens or dims them while held;
 * holding its on or off button does nothing, so it is there to choose. Any
 * other press switches them on or off, and a hold brightens or dims them by
 * turns. None for a remote in no room.
 */
export function defaultOf(
  button: Button,
  action: string,
  roomId: string | null,
): PressChoice | null {
  if (!roomId) return null;
  const isHold = button.features.holds.includes(action);
  const name = pressParts(action).button ?? "";
  const dimmer = isDimmer(button);
  if (dimmer && isHold && /(?:^|_)(?:on|off)$/i.test(name)) return null;
  const to: PressTo =
    dimmer && endsWith("up").test(name)
      ? isHold
        ? "brightenWhileHeld"
        : "brighter"
      : dimmer && endsWith("down").test(name)
        ? isHold
          ? "dimWhileHeld"
          : "dimmer"
        : dimmer && endsWith("on").test(name)
          ? "on"
          : dimmer && endsWith("off").test(name)
            ? "off"
            : isHold
              ? "brightenOrDimWhileHeld"
              : "toggle";
  return { kind: "lights", place: { kind: "room", id: roomId }, to };
}

// The keys Moods keeps the workflows by.
const pressKey = (device: string, action: string) =>
  `press:${device}:${action}`;
const fallbackKey = (device: string) => `default:${device}`;

type Doing = Exclude<PressChoice, { kind: "nothing" }>;

// The step that does what a press does.
function stepOf(choice: Doing, id: string) {
  return choice.kind === "lights"
    ? {
        id,
        kind: "step" as const,
        piece: "lights",
        config: { place: choice.place, to: choice.to },
      }
    : {
        id,
        kind: "step" as const,
        app: "sanctum.moods",
        piece: "moods.runMood",
        config: { id: choice.moodId },
      };
}

// From each of the remote's presses to what it does: one step for each
// thing done, which the presses that do it lead to.
function graphOf(
  device: string,
  presses: readonly { action: string; choice: Doing }[],
): WorkflowGraph {
  const steps = new Map<string, ReturnType<typeof stepOf>>();
  const nodes: WorkflowGraph["nodes"] = [];
  const edges: WorkflowGraph["edges"] = [];
  for (const [index, { action, choice }] of presses.entries()) {
    const key = JSON.stringify(choice);
    let step = steps.get(key);
    if (!step) {
      step = stepOf(
        choice,
        presses.length === 1
          ? choice.kind === "lights"
            ? "lights"
            : "mood"
          : `step-${steps.size + 1}`,
      );
      steps.set(key, step);
    }
    const trigger = presses.length === 1 ? "pressed" : `pressed-${index + 1}`;
    nodes.push({
      id: trigger,
      kind: "trigger",
      piece: "press",
      config: { device, action },
    });
    edges.push({ from: trigger, to: step.id });
  }
  return { version: 1, nodes: [...nodes, ...steps.values()], edges };
}

/** What the household chose for a remote's presses, by action. */
export async function readPresses(db: Db, deviceId: string) {
  const rows = await db
    .select()
    .from(presses)
    .where(eq(presses.deviceId, deviceId));
  return new Map(rows.map((row) => [row.action, row.choice]));
}

/** Keeps a press's choice; none takes it back. */
export async function choose(
  db: Db,
  deviceId: string,
  action: string,
  choice: PressChoice | null,
) {
  const where = and(eq(presses.deviceId, deviceId), eq(presses.action, action));
  if (choice === null) {
    await db.delete(presses).where(where);
    return;
  }
  await db
    .insert(presses)
    .values({ deviceId, action, choice })
    .onConflictDoUpdate({
      target: [presses.deviceId, presses.action],
      set: { choice },
    });
}

const lightKey = (device: string, capability: string) =>
  `${device}/${capability}`;

/** The home's lights, by device and capability. */
export function lightKeys(devices: readonly DeviceInfo[]) {
  return new Set(
    devices.flatMap((device) =>
      device.capabilities
        .filter((capability) => capability.kind === "light")
        .map((capability) => lightKey(device.id, capability.id)),
    ),
  );
}

/**
 * A choice as the home still has what it names: chosen lights the home no
 * longer has are left out, and a choice naming nothing the home has any
 * more goes.
 */
export function stillThere(
  choice: PressChoice,
  places: Places,
  moods: ReadonlySet<string>,
  lights: ReadonlySet<string>,
): PressChoice | null {
  if (choice.kind === "mood") {
    return moods.has(choice.moodId) ? choice : null;
  }
  if (choice.kind !== "lights" || choice.place.kind === "home") {
    return choice;
  }
  if (choice.place.kind === "lights") {
    const kept = choice.place.lights.filter((light) =>
      lights.has(lightKey(light.device, light.capability)),
    );
    return kept.length === 0
      ? null
      : kept.length === choice.place.lights.length
        ? choice
        : { ...choice, place: { kind: "lights", lights: kept } };
  }
  const { kind, id: placeId } = choice.place;
  return (kind === "room" ? places.rooms : places.zones).some(
    (each) => each.id === placeId,
  )
    ? choice
    : null;
}

// Leave room for the press label within the core's workflow name limit.
function workflowName(deviceName: string, action: string) {
  const label = action.replaceAll("_", " ");
  return `${deviceName.slice(0, 120 - label.length - 2)}: ${label}`;
}

async function sync(ctx: AppContext, deviceId?: string) {
  const revision = await ctx.permissions.revision();
  const granted = await ctx.permissions.list();
  if (!granted.includes(workflowsManagePermission)) return;
  // Only with everything a choice names in sight can it tell what is gone.
  const inSight = [
    readPermission("button"),
    controlPermission("light"),
    placesReadPermission,
  ].every((permission) => granted.includes(permission));
  const db = ctx.storage.db;
  const [devices, places, moods, rows, kept] = await Promise.all([
    inSight ? ctx.devices.list() : [],
    inSight ? ctx.places.list() : null,
    readMoods(db),
    db
      .select()
      .from(presses)
      .where(deviceId ? eq(presses.deviceId, deviceId) : undefined),
    ctx.workflows.list(),
  ]);
  // Reads use the current grants, which may have changed while loading,
  // even if they changed back. Leave this snapshot alone:
  // permissions.changed queues a fresh sync.
  if ((await ctx.permissions.revision()) !== revision) return;
  const moodIds = new Set(moods.map((mood) => mood.id));
  const lights = lightKeys(devices);
  const remotes = new Map(
    devices.flatMap((device) => {
      const button = buttonOf(device);
      return button && (deviceId === undefined || device.id === deviceId)
        ? [[device.id, { device, button }] as const]
        : [];
    }),
  );
  // A choice for a press, a remote, a place or a mood that is gone goes,
  // and chosen lights that are gone are left out of it. While any of them
  // is out of sight, nothing is gone: every choice stays as it is, and no
  // workflow is wanted.
  const chosen = new Map<string, Map<string, PressChoice>>();
  for (const row of rows) {
    if (!places) break;
    const remote = remotes.get(row.deviceId);
    const choice =
      remote &&
      remote.button.features.actions.includes(row.action) &&
      !(
        row.choice.kind === "lights" &&
        whileHeld.has(row.choice.to) &&
        !remote.button.features.holds.includes(row.action)
      )
        ? stillThere(row.choice, places, moodIds, lights)
        : null;
    // A save may have replaced this choice while the snapshot loaded.
    // Only change the value this sync actually read.
    const where = and(
      eq(presses.deviceId, row.deviceId),
      eq(presses.action, row.action),
      eq(presses.choice, row.choice),
    );
    if (!choice) {
      await db.delete(presses).where(where);
      continue;
    }
    if (choice !== row.choice) {
      await db.update(presses).set({ choice }).where(where);
    }
    const choices = chosen.get(row.deviceId) ?? new Map();
    choices.set(row.action, choice);
    chosen.set(row.deviceId, choices);
  }
  const wanted = new Map<string, KeptWorkflowRequest>();
  for (const [deviceId, { device, button }] of remotes) {
    const choices = chosen.get(deviceId) ?? new Map<string, PressChoice>();
    for (const [action, choice] of choices) {
      if (choice.kind === "nothing") continue;
      wanted.set(pressKey(deviceId, action), {
        key: pressKey(deviceId, action),
        name: workflowName(device.name, action),
        runMode: "queued",
        graph: graphOf(deviceId, [{ action, choice }]),
      });
    }
    const defaults = button.features.actions.flatMap((action) => {
      const choice = choices.has(action)
        ? null
        : defaultOf(button, action, device.roomId);
      return choice && choice.kind !== "nothing" ? [{ action, choice }] : [];
    });
    if (defaults.length > 0) {
      wanted.set(fallbackKey(deviceId), {
        key: fallbackKey(deviceId),
        name: workflowName(device.name, "presses not chosen"),
        runMode: "queued",
        graph: graphOf(deviceId, defaults),
      });
    }
  }
  for (const workflow of kept) {
    const key = workflow.appKey;
    const ours =
      deviceId === undefined
        ? key?.startsWith("press:") || key?.startsWith("default:")
        : key?.startsWith(`press:${deviceId}:`) ||
          key === fallbackKey(deviceId);
    if (key && ours && !wanted.has(key)) {
      await ctx.workflows.remove(key);
    }
  }
  for (const { key, ...workflow } of wanted.values()) {
    await ctx.workflows.put(key, workflow);
  }
}

let syncing: Promise<void> = Promise.resolve();

function inSyncQueue(run: () => Promise<void>) {
  const next = syncing.then(run);
  syncing = next.catch(() => undefined);
  return next;
}

/** Save and reconcile together, restoring the previous choice on failure. */
export function chooseAndSync(
  ctx: AppContext,
  deviceId: string,
  action: string,
  choice: PressChoice | null,
): Promise<void> {
  return inSyncQueue(async () => {
    const db = ctx.storage.db;
    const previous = (await readPresses(db, deviceId)).get(action) ?? null;
    await choose(db, deviceId, action, choice);
    try {
      await sync(ctx, deviceId);
    } catch (error) {
      // Both databases cannot share a transaction. Restore the choice
      // and any workflows already changed before reporting the failure.
      // Keeping this in the queue prevents rollback undoing a later save.
      // A rollback that fails too is logged; the first failure is the one
      // reported, since it is what went wrong.
      try {
        await choose(db, deviceId, action, previous);
        await sync(ctx, deviceId);
      } catch (rollback) {
        ctx.log(
          `could not put back the press ${action} of ${deviceId} (${rollback instanceof Error ? rollback.message : String(rollback)})`,
        );
      }
      throw error;
    }
  });
}

/**
 * Brings the workflows Moods keeps for remotes in line with the choices,
 * one sync at a time, so two never put and remove the same key at once.
 * An action syncs only its remote, which is all it changed.
 */
export function syncPresses(ctx: AppContext, deviceId?: string): Promise<void> {
  return inSyncQueue(() => sync(ctx, deviceId));
}
