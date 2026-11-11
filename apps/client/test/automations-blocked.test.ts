import type { AppInfo, PieceInfo, WorkflowGraph } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import {
  blockedBy,
  blockedLine,
  blockedWords,
} from "../src/automations/blocked";
import { workflow } from "./automations-fixtures";

// An app that keeps an automation from running: one it uses or that keeps it
// while the app isn't running, or the app that keeps it while its grants
// don't cover it.

const app = (id: string, name: string, state: AppInfo["state"]) =>
  ({
    id,
    name,
    state,
    permissions: [],
    requests: [
      {
        id: "devices.control:light",
        reason: "To set them.",
        needed: true,
        asked: null,
        startsOn: false,
      },
    ],
  }) as unknown as AppInfo;

const moods = app("sanctum.moods", "Moods", "running");
const weather = app("sanctum.weather", "Weather", "running");

const runsAMood: WorkflowGraph = {
  version: 1,
  nodes: [
    { id: "t", kind: "trigger", piece: "manual", config: {} },
    {
      id: "s",
      kind: "step",
      app: "sanctum.moods",
      piece: "moods.runMood",
      config: { id: "aurora" },
    },
  ],
  edges: [{ from: "t", to: "s" }],
};
const household = workflow({ id: "h", name: "Movie", graph: runsAMood });
const kept = workflow({
  id: "k",
  name: "Bedside remote",
  graph: runsAMood,
  app: "sanctum.weather",
});

describe("an app that keeps an automation from running", () => {
  it("is an app one of whose pieces needs a permission that is off", () => {
    const step: PieceInfo = {
      kind: "step",
      app: "sanctum.moods",
      id: "moods.runMood",
      title: "Run a mood",
      config: {},
      icon: null,
      sentence: null,
      card: null,
      presets: [],
      needs: ["people.read"],
      group: null,
    };
    const blocked = blockedBy(household, [moods, weather], [step])!;
    expect(blockedLine(blocked)).toBe("Can't run without “See who lives here”");
    expect(blockedWords(blocked)).toEqual({
      title: "It can't run without “See who lives here”",
      detail:
        "Moods needs it for this automation. Turn it on in Moods settings.",
    });
    // Once it is on, nothing keeps it.
    expect(
      blockedBy(
        household,
        [{ ...moods, permissions: ["people.read"] }, weather],
        [step],
      ),
    ).toBeNull();
  });

  it("is none while the apps it uses run and its grants cover it", () => {
    expect(blockedBy(household, [moods, weather])).toBeNull();
    expect(blockedBy(kept, [moods, weather])).toBeNull();
  });

  it("is an app whose piece it uses while the app is paused or stopped", () => {
    const paused = { ...moods, state: "paused" as const };
    const blocked = blockedBy(household, [paused])!;
    expect(blockedLine(blocked)).toBe("Can't run while Moods is paused");
    expect(blockedWords(blocked)).toEqual({
      title: "It can't run while Moods is paused",
      detail:
        "Moods needs “Control your lights”. Turn it back on in Moods settings.",
    });

    const stopped = blockedBy(household, [{ ...moods, state: "stopped" }])!;
    expect(blockedLine(stopped)).toBe("Can't run while Moods isn't running");
    expect(blockedWords(stopped).detail).toBe(
      "Moods starts again when Sanctum restarts.",
    );
  });

  it("is the app that keeps it first", () => {
    const blocked = blockedBy(kept, [
      { ...moods, state: "paused" },
      { ...weather, state: "stopped" },
    ]);
    expect(blocked).toMatchObject({
      app: { name: "Weather" },
      kind: "stopped",
    });
  });

  it("names what the app that keeps it lacks, in Sanctum's words", () => {
    const suspended = {
      ...kept,
      suspended: [
        {
          node: "t",
          field: null,
          message: "sanctum.weather does not hold devices.read:button",
          permission: "devices.read:button",
        },
      ],
    };
    const blocked = blockedBy(suspended, [moods, weather])!;
    expect(blockedLine(blocked)).toBe(
      "Can't run without “See your remotes' presses”",
    );
    expect(blockedWords(blocked)).toEqual({
      title: "It can't run without “See your remotes' presses”",
      detail:
        "Weather keeps it, and no longer has that permission. Turn it back on in Weather settings.",
    });

    // What no permission would cover keeps the core's words.
    const other = blockedBy(
      {
        ...kept,
        suspended: [
          {
            node: "t",
            field: null,
            message:
              "The device trigger names a capability its device does not have",
          },
        ],
      },
      [moods, weather],
    )!;
    expect(blockedLine(other)).toBe(
      "Can't run: the device trigger names a capability its device does not have",
    );
  });
});
