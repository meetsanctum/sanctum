import { describe, expect, it } from "vitest";

import {
  autoName,
  graphOf,
  isSimple,
  needsValue,
} from "../src/automations/graph";
import { deviceKindsFor } from "../src/automations/chooser";
import { lightLevelIn } from "../src/automations/fields";
import { dayWords, listStatus, runWords } from "../src/automations/when";
import {
  cardOf,
  compareGroups,
  fieldKind,
  fieldsOf,
  formatDays,
  formatLux,
  formatOffset,
  formatValue,
  groupOf,
  nodeParts,
  plain,
  presetOf,
} from "../src/automations/words";
import {
  deviceCondition,
  deviceTrigger,
  devices,
  lightLevel,
  lights,
  manual,
  motion,
  motionSensor,
  names,
  noMotion,
  places,
  press,
  runMood,
  sun,
  time,
  workflow,
} from "./automations-fixtures";

describe("Automations' words", () => {
  it("say days as a sentence and as a card do", () => {
    expect(formatDays(undefined, "sentence")).toBe("every day");
    expect(formatDays(["mon", "tue", "wed", "thu", "fri"], "sentence")).toBe(
      "on weekdays",
    );
    expect(formatDays(["sun", "sat"], "card")).toBe("Weekends");
    expect(formatDays(["fri"], "card")).toBe("Fridays");
    expect(formatDays(["thu", "mon"], "sentence")).toBe("on Mon, Thu");
  });

  it("say minutes before or after", () => {
    expect(formatOffset(0, "sentence")).toBe("on the dot");
    expect(formatOffset(-15, "sentence")).toBe("15 minutes before");
    expect(formatOffset(-15, "card")).toBe("15 min before");
    expect(formatOffset(1, "sentence")).toBe("1 minute after");
  });

  it("read a node by its preset's sentence, with its values as tokens", () => {
    const node = { config: { event: "sunset", offsetMinutes: -15 } };
    expect(presetOf(sun, node.config)?.title).toBe("At sunset");
    expect(plain(nodeParts(sun, node, names))).toBe(
      "At sunset, 15 minutes before",
    );
    expect(cardOf(sun, node, names)).toEqual({
      name: "Sunset",
      specifics: "15 min before",
    });
  });

  it("mark a value that names what is gone as missing", () => {
    const parts = nodeParts(
      lights,
      { config: { place: { kind: "room", id: "attic" }, to: "off" } },
      names,
    );
    expect(parts).toContainEqual({
      field: "place",
      text: "Choose a room",
      missing: true,
    });
    expect(
      plain(
        nodeParts(
          lights,
          { config: { place: { kind: "home" }, to: "on" } },
          names,
        ),
      ),
    ).toBe("Turn on the lights in the whole home");
  });

  it("read a step while held and chosen lights by their names", () => {
    expect(
      plain(
        nodeParts(
          lights,
          {
            config: {
              place: {
                kind: "lights",
                lights: [{ device: "ceiling", capability: "light" }],
              },
              to: "brightenWhileHeld",
            },
          },
          names,
        ),
      ),
    ).toBe("While held, brighten the lights in Office ceiling");
  });

  it("read an optional value left out as any, and a press by its label", () => {
    expect(
      plain(nodeParts(press, { config: { device: "button" } }, names)),
    ).toBe("Any press on Office button");
    expect(
      cardOf(press, { config: { device: "button", action: "single" } }, names),
    ).toEqual({
      name: "Office button",
      specifics: "Single press",
    });
  });

  it("read an app's entity by its name", () => {
    expect(plain(nodeParts(runMood, { config: { id: "focus" } }, names))).toBe(
      "Run Focus",
    );
  });

  it("group triggers by their type: the core's groups, a device's category, an app", () => {
    expect(groupOf(time, { config: {} }, names)).toBe("Time");
    expect(
      groupOf(
        { ...press, group: null },
        { config: { device: "button" } },
        names,
      ),
    ).toBe("Buttons");
    expect(
      groupOf({ ...runMood, kind: "trigger" }, { config: {} }, names),
    ).toBe("Moods");
    expect(
      ["By hand", "Moods", "Lights", "Time", "Sunrise and sunset"].sort(
        compareGroups,
      ),
    ).toEqual(["Time", "Sunrise and sunset", "Lights", "Moods", "By hand"]);
  });
});

describe("Automations' words for motion and light", () => {
  const office = { kind: "room", id: "office" };

  it("say how long as minutes, and on a card as min", () => {
    const node = { config: { place: office, forMinutes: 10 } };
    expect(plain(nodeParts(noMotion, node, names))).toBe(
      "No motion in Office for 10 minutes",
    );
    expect(cardOf(noMotion, node, names)).toEqual({
      name: "Office",
      specifics: "No motion for 10 min",
    });
    expect(
      plain(
        nodeParts(
          noMotion,
          { config: { place: office, forMinutes: 1 } },
          names,
        ),
      ),
    ).toBe("No motion in Office for 1 minute");
    expect(
      nodeParts(noMotion, { config: { place: office } }, names),
    ).toContainEqual({
      field: "forMinutes",
      text: "Choose how long",
      missing: true,
    });
  });

  it("say a light level in lux, and capitalise a sentence that starts with a value", () => {
    expect(
      plain(
        nodeParts(
          lightLevel,
          { config: { place: { kind: "home" }, is: "darker", lux: 30 } },
          names,
        ),
      ),
    ).toBe("The whole home is darker than 30 lx");
    expect(
      plain(
        nodeParts(
          lightLevel,
          { config: { place: office, is: "brighter", lux: 1500 } },
          names,
        ),
      ),
    ).toBe("Office is brighter than 1,500 lx");
    expect(formatLux(0.5)).toBe("0.5 lx");
  });

  it("word the operators that compare a field, below and above too", () => {
    const operator = fieldsOf(deviceCondition.config).operator!;
    expect(fieldKind(operator)).toEqual({
      kind: "choice",
      labels: {
        equals: "is",
        not_equals: "is not",
        is_on: "is on",
        is_off: "is off",
        below: "is below",
        above: "is above",
      },
    });
    expect(formatValue(operator, "below", names, "sentence")).toBe("is below");
    expect(formatValue(operator, "above", names, "card")).toBe("Is above");
  });

  it("read the motion presets, and fit a device by the field compared", () => {
    expect(
      plain(
        nodeParts(
          deviceTrigger,
          {
            config: {
              device: "motion",
              kind: "occupancy",
              field: "occupied",
              operator: "is_on",
            },
          },
          names,
        ),
      ),
    ).toBe("Office motion sensor detects motion");
    expect(deviceKindsFor(deviceCondition, { field: "occupied" })).toEqual([
      "occupancy",
    ]);
    expect(deviceKindsFor(deviceCondition, { field: "value" })).toEqual([
      "sensor",
    ]);
    expect(deviceKindsFor(deviceCondition, { field: "on" })).toEqual([
      "light",
      "switch",
    ]);
    expect(deviceKindsFor(deviceTrigger, { kind: "occupancy" })).toEqual([
      "occupancy",
    ]);
  });

  it("list motion among the core's named groups, a motion sensor's device trigger too", () => {
    expect(groupOf(motion, { config: {} }, names)).toBe("Motion");
    expect(
      groupOf(deviceTrigger, { config: { kind: "occupancy" } }, names),
    ).toBe("Motion");
    expect(groupOf(deviceTrigger, { config: { kind: "sensor" } }, names)).toBe(
      "Environment",
    );
    expect(
      [
        "By hand",
        "Moods",
        "Lights",
        "Motion",
        "Time",
        "Sunrise and sunset",
      ].sort(compareGroups),
    ).toEqual([
      "Time",
      "Sunrise and sunset",
      "Motion",
      "Lights",
      "Moods",
      "By hand",
    ]);
  });

  it("read a place's light level now from the brightest sensor that answers", () => {
    const home = { places, devices: [...devices], entities: [] };
    expect(lightLevelIn(home, office)).toBeNull();
    home.devices.push(motionSensor, {
      ...motionSensor,
      id: "bright",
      capabilities: [
        {
          ...motionSensor.capabilities[1]!,
          observed: { value: 900 },
        },
      ],
      availability: "offline",
    } as never);
    expect(lightLevelIn(home, office)).toBe(320);
    expect(lightLevelIn(home, { kind: "home" })).toBe(320);
    expect(lightLevelIn(home, { kind: "room", id: "living" })).toBeNull();
  });
});

describe("Automations' graphs", () => {
  const nodes = [
    { id: "s1", kind: "step" as const, piece: "lights", config: {} },
    { id: "t1", kind: "trigger" as const, piece: "time", config: {} },
    { id: "c1", kind: "condition" as const, piece: "lights", config: {} },
    { id: "s2", kind: "step" as const, piece: "lights", config: {} },
  ];

  it("lead every trigger through the conditions to every step, in that order", () => {
    const graph = graphOf(nodes);
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "t1",
      "c1",
      "s1",
      "s2",
    ]);
    expect(graph.edges).toEqual([
      { from: "t1", to: "c1" },
      { from: "c1", to: "s1" },
      { from: "c1", to: "s2" },
    ]);
    expect(isSimple(graph)).toBe(true);
    expect(isSimple({ ...graph, edges: [{ from: "t1", to: "s1" }] })).toBe(
      false,
    );
  });

  it("need a value a required field lacks, and are named after their trigger", () => {
    const trigger = {
      id: "t1",
      kind: "trigger" as const,
      piece: "sun",
      config: { event: "sunset" },
    };
    expect(needsValue(sun, trigger, names)).toBe(false);
    expect(
      needsValue(time, { ...trigger, piece: "time", config: {} }, names),
    ).toBe(true);
    expect(autoName([trigger], [sun], names)).toBe("At sunset");
  });
});

describe("Automations' statuses", () => {
  const now = new Date("2026-10-30T14:32:00");
  const base = workflow({
    id: "w",
    name: "Morning",
    graph: { version: 1, nodes: [], edges: [] },
  });

  it("say when a day is, as people do", () => {
    expect(dayWords(new Date("2026-10-30T07:30:00"), now)).toBe("today");
    expect(dayWords(new Date("2026-10-31T07:30:00"), now)).toBe("tomorrow");
    expect(dayWords(new Date("2026-11-02T07:30:00"), now)).toBe("Monday");
    expect(dayWords(new Date("2026-11-06T07:30:00"), now)).toBe("next Friday");
    expect(dayWords(new Date("2026-10-28T07:30:00"), now)).toBe(
      "last Wednesday",
    );
  });

  it("put the home's next run in the ink, and otherwise how today went", () => {
    const next = {
      ...base,
      nextRun: new Date("2026-10-30T16:51:00").toISOString(),
    };
    expect(listStatus(next, { now, nextId: "w" })).toEqual({
      kind: "next",
      text: "Next at 16:51",
      ink: true,
    });
    expect(
      listStatus({ ...next, enabled: false }, { now, nextId: "w" })?.text,
    ).toBe("Off");
    expect(
      listStatus(
        {
          ...base,
          lastRun: {
            id: "r",
            status: "skipped",
            at: new Date("2026-10-30T07:30:00").toISOString(),
          },
        },
        { now },
      )?.text,
    ).toBe("Skipped today");
    expect(
      listStatus(
        { ...base, problems: [{ node: "n", field: null, message: "Gone" }] },
        { now },
      ),
    ).toBeNull();
  });

  it("say who ran a run, a person or a shared device", () => {
    const run = {
      status: "succeeded" as const,
      reason: null,
      steps: [],
      startedOn: null,
    };
    expect(runWords({ ...run, startedBy: "maya" }, () => "Maya")).toEqual({
      kind: "ran",
      text: "Run by",
      by: "Maya",
    });
    expect(
      runWords(
        { ...run, startedBy: null, startedOn: "Kitchen tablet" },
        () => undefined,
      ).text,
    ).toBe("Run on Kitchen tablet");
    expect(
      runWords(
        { ...run, status: "skipped", reason: "conditions", startedBy: null },
        () => undefined,
      ).text,
    ).toBe("Skipped: a condition wasn't met");
    expect(manual.group).toBe("By hand");
  });

  it.each([
    ["failed", "Failed yesterday"],
    ["partial", "Failed yesterday"],
    ["skipped", "Skipped yesterday"],
    ["cancelled", "Stopped yesterday"],
    ["running", "Running"],
    ["queued", "Waiting to run"],
  ] as const)("does not call a %s run successful", (status, text) => {
    expect(
      listStatus(
        {
          ...base,
          lastRun: {
            id: "r",
            status,
            at: new Date("2026-10-29T07:30:00").toISOString(),
          },
        },
        { now },
      )?.text,
    ).toBe(text);
  });
});
