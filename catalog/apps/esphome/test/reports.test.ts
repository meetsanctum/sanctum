import {
  createAppContext,
  type CoreCalls,
  type DeviceReport,
} from "@meetsanctum/app-sdk";
import { entityId, EspHomeClient, MediaPlayerState } from "esphome-client";
import { afterEach, expect, it, vi } from "vitest";

import type { Session } from "../src/connection.js";
import { createFacts } from "../src/facts.js";
import { createReports } from "../src/reports.js";

const url = "http://192.168.1.20:4180/a/abc.flac";
const player = { type: "media_player", key: 201, objectId: "player" } as const;
const capability = "media-player";

function setup() {
  vi.useFakeTimers();
  const states: NonNullable<DeviceReport["states"]>[string][] = [];
  const appId = "sanctum.example";
  const ctx = createAppContext({
    appId,
    actor: { kind: "app", id: appId },
    core: {
      report: async ({ states: reported }) => {
        if (reported?.[capability]) states.push(reported[capability]);
      },
    } as CoreCalls,
  });
  const address = { host: "127.0.0.1", port: 6053 };
  const session: Session = {
    client: new EspHomeClient(address),
    info: { voiceAssistantFeatureFlags: 1 },
    entities: [{ ...player, name: "Player" }],
    encrypted: false,
    address,
    listen() {},
  };
  let current: Session | null = session;
  const reports = createReports(ctx, "speaker", {
    timings: { firstPauseMs: 20, longestPauseMs: 100 },
    facts: createFacts(ctx.storage.db),
    current: () => current,
    capabilities: [],
  });
  reports.announced(session, player.key, url);
  return {
    states,
    state: (state: MediaPlayerState, volume: number) =>
      reports.state(
        {
          type: player.type,
          entity: entityId(player.type, player.objectId),
          key: player.key,
          state,
          volume,
        },
        session,
      ),
    fetched: (address: string) => reports.announcementFetched(session, address),
    disconnect: () => {
      current = null;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

it("keeps the player's activity when the fetch notice comes after playback", () => {
  const { states, state, fetched } = setup();
  state(MediaPlayerState.PLAYING, 0.4);
  state(MediaPlayerState.IDLE, 0.5);
  expect(states).toEqual([]);

  fetched(url);
  expect(states).toEqual([
    { activity: "idle", volume: 40, muted: false },
    { activity: "idle", volume: 50, muted: false },
  ]);
  vi.advanceTimersByTime(5_000);
  expect(states).toHaveLength(2);
});

it("reports ordinary playback when the announcement's fetch notice never comes", () => {
  const { states, state, fetched } = setup();
  state(MediaPlayerState.PLAYING, 0.4);
  fetched("http://192.168.1.20:4180/a/old.flac");
  vi.advanceTimersByTime(4_999);
  expect(states).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(states).toEqual([{ activity: "playing", volume: 40, muted: false }]);
});

it("drops held reports when the speaker's connection ends", () => {
  const { states, state, disconnect } = setup();
  state(MediaPlayerState.PLAYING, 0.4);
  disconnect();
  vi.advanceTimersByTime(5_000);
  expect(states).toEqual([]);
});
