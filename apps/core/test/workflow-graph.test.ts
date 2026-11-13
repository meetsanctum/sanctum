import type { WorkflowGraph } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import {
  changeFires,
  executionPlan,
  hasTriggerToStepPath,
  statePasses,
} from "../src/workflows/graph.js";

// A workflow's graph: which steps a run reaches, and how a change of state
// fires a trigger.

const node = (
  id: string,
  kind: "trigger" | "condition" | "step",
  piece = kind === "trigger" ? "manual" : "device",
) => ({ id, kind, piece, config: {} });

describe("executionPlan", () => {
  it("does not run disconnected steps for a matching trigger", () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        node("trigger", "trigger"),
        node("mood-a", "step"),
        node("mood-b", "step"),
      ],
      edges: [{ from: "trigger", to: "mood-a" }],
    };
    expect(
      executionPlan(graph, new Set(["trigger"])).map(({ step }) => step.id),
    ).toEqual(["mood-a"]);
  });

  it("reaches each step through the conditions on any path to it", async () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        node("trigger", "trigger"),
        node("dark", "condition"),
        node("home", "condition"),
        node("mood-a", "step"),
        node("mood-b", "step"),
      ],
      edges: [
        { from: "trigger", to: "dark" },
        { from: "dark", to: "mood-a" },
        { from: "trigger", to: "home" },
        { from: "home", to: "mood-a" },
        { from: "trigger", to: "mood-b" },
      ],
    };
    const plan = executionPlan(graph, new Set(["trigger"]));
    const asked: string[] = [];
    const passes =
      (results: Record<string, boolean>) =>
      async (condition: { id: string }) => {
        asked.push(condition.id);
        return results[condition.id]!;
      };

    expect(plan.map(({ step }) => step.id)).toEqual(["mood-a", "mood-b"]);
    // The first path fails at dark, the second passes at home.
    expect(await plan[0]!.reached(passes({ dark: false, home: true }))).toBe(
      true,
    );
    expect(asked).toEqual(["dark", "home"]);
    // A step with no conditions before it is always reached.
    expect(await plan[1]!.reached(passes({}))).toBe(true);
    asked.length = 0;
    expect(await plan[0]!.reached(passes({ dark: false, home: false }))).toBe(
      false,
    );
    expect(asked).toEqual(["dark", "home"]);
  });

  it("ends a path at the step it reaches", async () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [node("trigger", "trigger"), node("a", "step"), node("b", "step")],
      edges: [
        { from: "trigger", to: "a" },
        { from: "a", to: "b" },
      ],
    };
    expect(
      executionPlan(graph, new Set(["trigger"])).map(({ step }) => step.id),
    ).toEqual(["a"]);
  });

  it("starts only from the triggers that fired", () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        node("morning", "trigger", "time"),
        node("evening", "trigger", "time"),
        node("wake", "step"),
        node("sleep", "step"),
      ],
      edges: [
        { from: "morning", to: "wake" },
        { from: "evening", to: "sleep" },
      ],
    };
    expect(
      executionPlan(graph, new Set(["evening"])).map(({ step }) => step.id),
    ).toEqual(["sleep"]);
  });

  it("does not follow a cycle forever", () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        node("trigger", "trigger"),
        node("a", "condition"),
        node("b", "condition"),
        node("step", "step"),
      ],
      edges: [
        { from: "trigger", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "a" },
        { from: "b", to: "step" },
      ],
    };
    expect(executionPlan(graph, new Set(["trigger"]))).toHaveLength(1);
    expect(hasTriggerToStepPath(graph)).toBe(true);
    expect(
      hasTriggerToStepPath({ ...graph, edges: [{ from: "a", to: "step" }] }),
    ).toBe(false);
  });
});

describe("changeFires", () => {
  // On a light's state as Devices keeps it.
  const now = { on: true, brightness: 80 };
  const wasOn = { on: true, brightness: 60 };
  const wasOff = { on: false, brightness: 80 };

  it("fires when the field changed to a value that passes", () => {
    expect(changeFires({ field: "on", operator: "is_on" }, wasOff, now)).toBe(
      true,
    );
    expect(changeFires({ field: "on", operator: "is_on" }, wasOn, now)).toBe(
      false,
    );
    expect(changeFires({ field: "on", operator: "is_off" }, now, wasOff)).toBe(
      true,
    );
  });

  it("fires below and above as a number crosses into them, not on every reading past it", () => {
    const below = { field: "value", operator: "below", value: 30 } as const;
    const above = { field: "value", operator: "above", value: 30 } as const;
    expect(changeFires(below, { value: 40 }, { value: 20 })).toBe(true);
    expect(changeFires(below, { value: 20 }, { value: 12 })).toBe(false);
    expect(changeFires(below, null, { value: 12 })).toBe(true);
    expect(changeFires(below, { value: 20 }, { value: 30 })).toBe(false);
    expect(changeFires(above, { value: 30 }, { value: 31 })).toBe(true);
    expect(changeFires(above, { value: 31 }, { value: 50 })).toBe(false);
    // A value that is not a number never passes.
    expect(changeFires(below, { value: 40 }, { value: "dark" })).toBe(false);
  });

  it("compares a value with equals and not_equals", () => {
    expect(
      changeFires(
        { field: "brightness", operator: "equals", value: 80 },
        wasOn,
        now,
      ),
    ).toBe(true);
    expect(
      changeFires(
        { field: "brightness", operator: "not_equals", value: 60 },
        wasOn,
        now,
      ),
    ).toBe(true);
    expect(
      changeFires(
        { field: "brightness", operator: "equals", value: 60 },
        wasOn,
        now,
      ),
    ).toBe(false);
  });

  it("fires on a value that passes when there was nothing before", () => {
    expect(changeFires({ field: "on", operator: "is_on" }, null, now)).toBe(
      true,
    );
  });

  it("fires on any change without a field, and on none without one", () => {
    expect(changeFires({}, wasOn, now)).toBe(true);
    expect(changeFires({}, now, { ...now })).toBe(false);
    expect(changeFires({}, null, now)).toBe(true);
  });

  it("accepts a state. prefix and nested fields", () => {
    expect(
      changeFires(
        { field: "state.on", operator: "is_on" },
        { on: false },
        { on: true },
      ),
    ).toBe(true);
    expect(
      changeFires(
        { field: "color.hue", operator: "equals", value: 20 },
        { color: { hue: 10 } },
        { color: { hue: 20 } },
      ),
    ).toBe(true);
  });

  it("does not fire on a field the state lacks", () => {
    expect(
      changeFires({ field: "hue", operator: "equals", value: 20 }, null, now),
    ).toBe(false);
  });
});

describe("statePasses", () => {
  it("checks a field of the state now", () => {
    expect(statePasses({ field: "on", operator: "is_on" }, { on: true })).toBe(
      true,
    );
    expect(
      statePasses(
        { field: "brightness", operator: "equals", value: 40 },
        { on: true, brightness: 41 },
      ),
    ).toBe(false);
    expect(statePasses({ field: "on", operator: "is_off" }, {})).toBe(false);
  });
});
