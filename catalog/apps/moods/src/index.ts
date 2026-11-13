import {
  defineApp,
  defineDevicePage,
  defineRoomSection,
  turnOnType,
  type AppContext,
  type DeviceEvent,
  type DeviceInfo,
} from "@meetsanctum/app-sdk";
import { isDeepStrictEqual } from "node:util";

import { moodActions, runMood } from "./moods/actions.js";
import { moodType, publishMoods, roomsOf } from "./moods/entities.js";
import { smartMoodActions } from "./moods/smart-actions.js";
import { keepRoomMoods, removeRoomMoods } from "./moods/store.js";
import { motionActions } from "./motion/actions.js";
import {
  keepRoomMotion,
  removeRoomMotion,
  syncMotion,
} from "./motion/motion.js";
import { readsLightLevel } from "./motion/room-motion.js";
import { pressActions } from "./presses/actions.js";
import { buttonOf, syncPresses } from "./presses/presses.js";
import { scheduleActions } from "./schedules/actions.js";
import { syncJobs } from "./schedules/jobs.js";
import { createSnapshots, type Snapshots } from "./schedules/snapshots.js";
import {
  keepRoomSchedules,
  removeRoomSchedules,
  replaceSnapshot,
} from "./schedules/store.js";
import { publishTurnOn } from "./schedules/turn-on.js";
import { lightsInRoom } from "./targets.js";

// Moods: the moods that set a room's lights, in its own database. The
// devices, places and the pages that show them are the core's and the
// shell's. It publishes each mood as a moods.mood entity, with whether the
// room's lights show it, following the lights to keep that current, and the
// shell draws them on each room's page as Moods' room section, where a tap
// runs the mood. A room's moods go with it: when the core deletes it while
// Moods runs, and when Moods starts for one deleted while it did not.
// Workflows may run its moods; the core's own lights pieces switch a place's
// lights and ask whether they are on. It says what each press of a remote
// does, on the Presses page it adds to a remote's detail, and keeps a
// workflow for each choice (presses/). Each room has a schedule of its
// moods, which its jobs run, and a rule for what turning its lights on
// brings, which it publishes as the room's lights.turnOn for the core's
// lights switch, from the snapshot it takes as the room goes dark
// (schedules/). A room may turn its lights on with motion and off with no
// motion, which Moods keeps as a workflow each from the core's motion pieces
// (motion/). Its UI is in ./ui, which the shell bundles.

// What its start keeps of the home, which a resume catches up.
let running:
  | { snapshots: Snapshots; snapshotDevices: Map<string, DeviceInfo> }
  | undefined;

export default defineApp({
  id: "sanctum.moods",
  name: "Moods",
  version: "0.9.0",
  core: "^1.0.0",
  summary:
    "Moods for each room, and what remotes and motion do with its lights.",
  icon: { glyph: "swatch-book", color: "ember" },
  // The app overview opens main, every room; Edit beside a room page's
  // Moods opens room, the room's moods, schedule and turning on, which
  // opens the mood editor and the editor of a scheduled mood.
  pages: ["main", "room", "mood", "scheduled"],
  // Controlling a kind includes reading it. Rooms and their lights are what
  // moods are; the rest serve presses and motion. Presses start on, so a
  // remote switches its room's lights from its first press; motion and light
  // levels are asked for where they are turned on.
  permissions: [
    {
      id: "places.read",
      reason: "To keep moods for each room.",
      needed: true,
    },
    {
      id: "devices.control:light",
      reason: "To set your lights when a mood runs.",
      needed: true,
    },
    {
      id: "devices.read:button",
      reason: "So a press of a remote can run the mood you chose.",
      startsOn: true,
      asked: "when you choose what a remote's press does",
    },
    {
      id: "devices.read:occupancy",
      reason: "To turn a room's lights on when someone comes in.",
      asked: "when you turn on lights for motion",
    },
    {
      id: "devices.read:sensor",
      reason: "To leave a room's lights off while it is bright enough.",
      asked: "when you choose a light level for motion",
    },
    {
      id: "workflows.manage",
      reason: "So presses and motion run what you chose for them.",
      startsOn: true,
      asked: "with presses and motion",
    },
  ],
  migrations: "migrations",
  actions: [
    ...moodActions,
    ...smartMoodActions,
    ...pressActions,
    ...scheduleActions,
    ...motionActions,
  ],
  events: [],
  provides: {
    entities: [moodType, turnOnType],
    roomSections: [
      defineRoomSection({
        id: "moods.room",
        title: "Moods",
        entityType: moodType.id,
        kind: "tiles",
        // Moods' place, among the sections Sanctum keeps for its own.
        order: 200,
        press: runMood,
        open: { page: "room", label: "Edit" },
        // A room with lights but no moods yet keeps the heading and Edit,
        // so someone can add the first.
        whenEmpty: { roomHas: "light" },
        preview: [
          { icon: "sparkles", name: "Aurora", active: true },
          { icon: "book-open", name: "Reading", active: false },
          { icon: "moon", name: "Night", active: false },
        ],
      }),
    ],
    steps: [runMood],
    // What each press of a remote does (presses/).
    devicePages: [
      defineDevicePage({
        id: "moods.presses",
        title: "Presses",
        kinds: ["button"],
      }),
    ],
  },
  // Following first, so no room's deletion or light's change falls
  // between following and catching up. Then it says again all it owns in
  // the core, from its own database: each mood, each room's turning on,
  // every job of its schedules, and the workflows for presses and motion.
  // After an update, the core keeps only what the new version's start says.
  async start(ctx) {
    const snapshots = createSnapshots();
    const snapshotDevices = new Map<string, DeviceInfo>();
    running = { snapshots, snapshotDevices };
    await ctx.events.on("place.deleted", async ({ place }) => {
      if (place.kind === "room") {
        await removeRoomMoods(ctx.storage.db, place.id);
        await removeRoomSchedules(ctx.storage.db, place.id);
        await removeRoomMotion(ctx.storage.db, place.id);
        snapshots.forget(place.id);
        await publishMoods(ctx, [place.id]);
        await syncJobs(ctx);
        await publishTurnOn(ctx, [place.id]);
        await syncMotion(ctx, place.id);
      }
      await syncPresses(ctx);
    });
    // The home's day may now run in another time zone, and a room renamed
    // names the workflows motion runs in it.
    await ctx.events.on("place.changed", async ({ place, before }) => {
      if (
        place.kind === "home" &&
        before.kind === "home" &&
        place.timeZone !== before.timeZone
      ) {
        await syncJobs(ctx, { fresh: true });
        await publishTurnOn(ctx);
      }
      if (place.kind === "room" && place.name !== before.name) {
        await syncMotion(ctx, place.id);
      }
    });
    for (const name of [
      "device.added",
      "device.changed",
      "device.deleted",
    ] as const) {
      await ctx.events.on(name, async (event) => {
        const rooms = roomsOf(event);
        if (event.name === "device.deleted") {
          snapshotDevices.delete(event.device.id);
        } else {
          snapshotDevices.set(event.device.id, event.device);
        }
        await publishMoods(ctx, rooms);
        const dark = await followLights(ctx, snapshots, rooms, [
          ...snapshotDevices.values(),
        ]);
        await publishTurnOn(ctx, lightsMoved(event) ? rooms : dark);
        if (pressesFollow(event)) await syncPresses(ctx);
        for (const room of lightLevelMoved(event)) await syncMotion(ctx, room);
      });
    }
    // A permission switched on or off pauses or resumes presses and
    // motion; what the household chose for them stays either way.
    await ctx.events.on("permissions.changed", async () => {
      try {
        await syncPresses(ctx);
      } finally {
        // A failed remote sync must not leave motion running without
        // the permission it needs.
        await syncMotion(ctx);
      }
    });
    await catchUp(ctx, running);
  },
  // After the core restarted, what may have changed while it was away, as its
  // start catches up; what it follows stays.
  async resume(ctx) {
    if (running) await catchUp(ctx, running);
  },
  async stop() {
    running = undefined;
  },
});

// Everything it owns in the core, said again from its own database and the
// home as it is now.
async function catchUp(
  ctx: AppContext,
  {
    snapshots,
    snapshotDevices,
  }: { snapshots: Snapshots; snapshotDevices: Map<string, DeviceInfo> },
) {
  const { rooms } = await ctx.places.list();
  const roomIds = rooms.map((room) => room.id);
  await keepRoomMoods(ctx.storage.db, roomIds);
  await keepRoomSchedules(ctx.storage.db, roomIds);
  await keepRoomMotion(ctx.storage.db, roomIds);
  await publishMoods(ctx);
  snapshotDevices.clear();
  for (const device of await ctx.devices.list())
    snapshotDevices.set(device.id, device);
  await followLights(ctx, snapshots, roomIds, [...snapshotDevices.values()]);
  await syncJobs(ctx, { all: true });
  await publishTurnOn(ctx);
  await syncPresses(ctx);
  await syncMotion(ctx);
}

// Follows the lights of these rooms, and keeps the snapshot of each that
// has just gone dark; the rooms that did.
async function followLights(
  ctx: AppContext,
  snapshots: Snapshots,
  rooms: readonly string[],
  devices: readonly DeviceInfo[],
) {
  if (rooms.length === 0) return [];
  const now = new Date();
  const dark: string[] = [];
  for (const roomId of new Set(rooms)) {
    const lights = snapshots.follow(
      roomId,
      lightsInRoom(devices, roomId),
      now.getTime(),
    );
    if (!lights) continue;
    await replaceSnapshot(
      ctx.storage.db,
      { kind: "room", id: roomId },
      { takenAt: now.toISOString(), lights },
    );
    dark.push(roomId);
  }
  return dark;
}

// Whether a light came, went or moved, which what turning its rooms on
// names follows. A report changes none of that.
function lightsMoved(event: DeviceEvent) {
  if (event.name !== "device.changed") return true;
  const { device, before } = event;
  return (
    device.roomId !== before.roomId ||
    !isDeepStrictEqual(lightFeatures(device), lightFeatures(before))
  );
}

function lightFeatures(device: DeviceInfo) {
  return device.capabilities
    .filter((capability) => capability.kind === "light")
    .map(({ id, features }) => ({ id, features }));
}

// Whether a remote came, went, moved, was renamed or changed its presses,
// or a light that presses may have chosen went, which the workflows Moods
// keeps for remotes follow. A press only marks a remote seen, which they
// do not.
function pressesFollow(event: DeviceEvent) {
  const button = buttonOf(event.device);
  if (event.name !== "device.changed") {
    return (
      button !== undefined ||
      (event.name === "device.deleted" &&
        lightFeatures(event.device).length > 0)
    );
  }
  const before = event.before;
  const lights = new Set(lightFeatures(event.device).map((each) => each.id));
  if (lightFeatures(before).some((each) => !lights.has(each.id))) return true;
  return (
    (button !== undefined || buttonOf(before) !== undefined) &&
    (before.roomId !== event.device.roomId ||
      before.name !== event.device.name ||
      JSON.stringify(buttonOf(before)?.features) !==
        JSON.stringify(button?.features))
  );
}

// The rooms that gained or lost a sensor reading the light level, which
// the workflow motion turns their lights on with compares. A reading
// changes neither.
function lightLevelMoved(event: DeviceEvent): string[] {
  const reads = (device: DeviceInfo) =>
    device.roomId !== null && device.capabilities.some(readsLightLevel);
  if (event.name !== "device.changed") {
    return reads(event.device) ? [event.device.roomId!] : [];
  }
  const { device, before } = event;
  if (device.roomId === before.roomId && reads(device) === reads(before)) {
    return [];
  }
  return [
    ...new Set(
      [before, device].flatMap((each) => (reads(each) ? [each.roomId!] : [])),
    ),
  ];
}
