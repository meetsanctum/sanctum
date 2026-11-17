import {
  controlPermission,
  defineApp,
  defineRoomSection,
  placesLocationPermission,
  placesReadPermission,
  turnOnType,
} from "@meetsanctum/app-sdk";

import { naturalLightActions } from "./actions.js";
import { createFollower } from "./follower.js";
import { createRunForLight, type Timing } from "./lights.js";
import { roomType } from "./rooms.js";
import { naturalLightSettings } from "./settings.js";
import { targetType } from "./target.js";

// Natural light: lights that follow the sun through the day, warm and dim at
// night and cooler and brighter towards noon. It works out the sun itself
// from where the home is, so it needs no other app. Every light that takes
// a colour temperature follows it unless the household leaves it out, new
// ones too (choices.ts), and it brings a `naturalLight.target` entity for
// each, and a Natural light button beside each room's lights button where
// a light follows (rooms.ts). A switch in its settings turns it off
// altogether. Workflows can have a light follow it, pause or resume, or
// bring a room to natural light. Its UI is in ./ui, which opens in frames
// the core serves.
//
// The check is the app's job every 5 minutes; a light that is on is due
// every 5 minutes and one that is off every 15 (lights.ts). The core logs
// every run, so a shorter beat would fill the activity log; a light
// switched on through the core comes back at the curve without waiting for
// one, and so does every light once the household changes the curve
// (follower.ts).

export const checkJob = "check";

export type NaturalLightOptions = Partial<Timing>;

function timingOf(options: NaturalLightOptions): Timing {
  return {
    now: options.now ?? (() => new Date()),
    activeMs: options.activeMs ?? 5 * 60_000,
    offMs: options.offMs ?? 15 * 60_000,
  };
}

/** The app, with intervals and a clock a test may change. */
export function createNaturalLightApp(options: NaturalLightOptions = {}) {
  const timing = timingOf(options);
  const runForLight = createRunForLight();
  const {
    follow,
    followRoom,
    toggleRoom,
    bringRoom,
    resume,
    pause,
    preview,
    check,
  } = naturalLightActions(timing, runForLight);
  let follower: ReturnType<typeof createFollower> | undefined;

  return defineApp({
    id: "sanctum.natural-light",
    name: "Natural light",
    version: "0.1.0",
    core: "^1.0.0",
    summary: "Lights that follow the colour of daylight through the day.",
    icon: { glyph: "sun", color: "sun" },
    pages: ["main"],
    permissions: [
      {
        id: placesLocationPermission,
        reason: "To follow the sun where your home is.",
        needed: true,
      },
      {
        id: controlPermission("light"),
        reason: "To bring the lights that follow it to the light of the day.",
        needed: true,
      },
      // Its page lists lights by room, and lists them all together without
      // it.
      {
        id: placesReadPermission,
        reason: "To list your lights by room.",
        startsOn: true,
      },
    ],
    provides: {
      entities: [targetType, roomType, turnOnType],
      steps: [follow, pause, resume, bringRoom],
      roomSections: [
        defineRoomSection({
          id: "naturalLight.room",
          title: "Natural light",
          entityType: roomType.id,
          kind: "buttons",
          // Sanctum's own, as Moods' tiles are.
          order: 200,
          press: toggleRoom,
          preview: [{ icon: "sun", name: "Natural light", active: true }],
        }),
      ],
    },
    // The curve (settings.ts).
    settings: naturalLightSettings,
    migrations: "migrations",
    actions: [
      follow,
      followRoom,
      toggleRoom,
      bringRoom,
      resume,
      pause,
      preview,
      check,
    ],
    events: [],
    async start(ctx) {
      // Kept by the core across restarts; scheduling it again keeps its
      // beat.
      await ctx.jobs.schedule({
        key: checkJob,
        action: check,
        input: {},
        when: { every: 300 },
      });
      follower = createFollower(ctx, timing, runForLight);
      await follower.start();
    },
    // Its job is the core's, and its loop waits for the next change.
    async resume() {
      await follower?.resume();
    },
    async stop() {
      follower?.stop();
      follower = undefined;
    },
  });
}

export default createNaturalLightApp();
