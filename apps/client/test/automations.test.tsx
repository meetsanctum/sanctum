// @vitest-environment jsdom
import type {
  AppInfo,
  PieceInfo,
  WorkflowGraph,
  WorkflowRunInfo,
} from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutomationsPage } from "../src/automations/page";
import { coreJson } from "../src/core-fetch";
import type { useDevices } from "../src/use-devices";
import {
  devices,
  motionPieces,
  motionSensor,
  pieces,
  places,
  workflow,
} from "./automations-fixtures";

vi.mock("../src/core-fetch", async (original) => ({
  ...(await original()),
  coreJson: vi.fn(),
}));

const graph = (nodes: WorkflowGraph["nodes"]): WorkflowGraph => ({
  version: 1,
  nodes,
  edges: nodes
    .filter((node) => node.kind === "trigger")
    .flatMap((trigger) =>
      nodes
        .filter((node) => node.kind === "step")
        .map((step) => ({ from: trigger.id, to: step.id })),
    ),
});

const evening = workflow({
  id: "evening",
  name: "Evening in the office",
  graph: graph([
    {
      id: "t",
      kind: "trigger",
      piece: "sun",
      config: { event: "sunset", offsetMinutes: -15 },
    },
    {
      id: "s",
      kind: "step",
      piece: "lights",
      config: { place: { kind: "room", id: "office" }, to: "on" },
    },
  ]),
});
const movie = workflow({
  id: "movie",
  name: "Movie night",
  graph: graph([
    { id: "t", kind: "trigger", piece: "manual", config: {} },
    {
      id: "s",
      kind: "step",
      piece: "lights",
      config: { place: { kind: "home" }, to: "off" },
    },
  ]),
});

let container: HTMLDivElement;
let root: Root;
let workflows = [evening, movie];
let runs: WorkflowRunInfo[];
let availablePieces: PieceInfo[];
let homeDevices = devices;
let routes: { page: string; params: Record<string, string> }[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  workflows = [evening, movie];
  runs = [];
  availablePieces = pieces;
  homeDevices = devices;
  routes = [];
  vi.mocked(coreJson).mockImplementation(async (path, init) => {
    switch (path) {
      case "/api/workflows":
        return workflows;
      case "/api/workflows/pieces":
        return availablePieces;
      case "/api/entities":
      case "/api/people":
        return [];
      case "/api/workflows/run":
        return { id: "run" };
      case "/api/workflows/runs?workflow=movie":
        return runs;
      case "/api/workflows/add": {
        const added = workflow({
          id: "new",
          ...(init?.json as object),
        } as never);
        workflows = [...workflows, added];
        return added;
      }
      case "/api/workflows/update":
        return { ...movie, ...(init?.json as object) };
      default:
        throw new Error(`Unexpected request: ${path}`);
    }
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.mocked(coreJson).mockReset();
  vi.useRealTimers();
});

async function show(page = "main", params: Record<string, string> = {}) {
  await act(async () =>
    root.render(
      <AutomationsPage
        page={page}
        params={params}
        open={(next, nextParams = {}) =>
          routes.push({ page: next, params: nextParams })
        }
        back={() => routes.push({ page: "back", params: {} })}
        apps={[] as AppInfo[]}
        devices={
          { places, devices: homeDevices } as unknown as ReturnType<
            typeof useDevices
          >
        }
        live={createLiveFeed()}
        openAppSettings={() => {}}
        openStatus={() => {}}
        ask={async () => true}
      />,
    ),
  );
}

const buttons = (within: ParentNode = document) => [
  ...within.querySelectorAll<HTMLButtonElement>("button"),
];
// An entry in Add reads its title, then the piece's under it.
const press = async (text: string, within: ParentNode = document) => {
  const button =
    buttons(within).find((each) => each.textContent?.trim() === text) ??
    buttons(within).find((each) => each.textContent?.startsWith(text));
  if (!button) throw new Error(`No button ${text}`);
  await act(async () => button.click());
};

describe("the Automations list", () => {
  it("groups each automation by its trigger, led by its trigger's card", async () => {
    await show();
    const headings = [...container.querySelectorAll("h2")].map(
      (each) => each.textContent,
    );
    expect(headings).toEqual(["Sunrise and sunset", "By hand"]);
    expect(container.textContent).toContain("Sunset15 min before");
    expect(container.textContent).toContain("Turn on the lights in Office");
  });

  it("runs one that runs by hand from its row, and opens the others' pages", async () => {
    await show();
    await press("Run");
    expect(coreJson).toHaveBeenCalledWith("/api/workflows/run", {
      method: "POST",
      json: { id: "movie" },
    });
    await act(async () =>
      buttons(container)
        .find((each) => each.textContent?.includes("Evening in the office"))!
        .click(),
    );
    expect(routes).toEqual([{ page: "automation", params: { id: "evening" } }]);
  });

  it("says what an automation is when there are none", async () => {
    workflows = [];
    await show();
    expect(container.textContent).toContain("No automations yet");
  });
});

describe("an automation's page", () => {
  it("sends a broken one an app keeps to the app, not to Edit", async () => {
    workflows = [
      {
        ...evening,
        app: "sanctum.moods",
        problems: [
          {
            node: "s",
            field: "place.id",
            message: "The room it names was removed",
          },
        ],
      },
    ];
    await act(async () =>
      root.render(
        <AutomationsPage
          page="automation"
          params={{ id: "evening" }}
          open={() => {}}
          back={() => {}}
          apps={[
            { id: "sanctum.moods", name: "Moods", state: "running" } as AppInfo,
          ]}
          devices={
            { places, devices } as unknown as ReturnType<typeof useDevices>
          }
          live={createLiveFeed()}
          openAppSettings={() => {}}
          openStatus={() => {}}
          ask={async () => true}
        />,
      ),
    );
    expect(container.textContent).toContain("Change it in Moods.");
    expect(container.textContent).not.toContain("Edit it to fix it.");
  });

  it("reads and runs one an app keeps, with no Edit or switch", async () => {
    workflows = [{ ...evening, app: "sanctum.moods" }];
    await act(async () =>
      root.render(
        <AutomationsPage
          page="automation"
          params={{ id: "evening" }}
          open={() => {}}
          back={() => {}}
          apps={[
            { id: "sanctum.moods", name: "Moods", state: "running" } as AppInfo,
          ]}
          devices={
            { places, devices } as unknown as ReturnType<typeof useDevices>
          }
          live={createLiveFeed()}
          openAppSettings={() => {}}
          openStatus={() => {}}
          ask={async () => true}
        />,
      ),
    );
    const labels = buttons(container).map((each) => each.textContent);
    expect(labels).toContain("Run");
    expect(labels).not.toContain("Edit");
    expect(container.querySelector('[role="switch"]')).toBeNull();
    expect(container.textContent).toContain(
      "Moods keeps this automation, so it's changed in Moods.",
    );
  });
});

describe("an automation an app keeps from running", () => {
  const paused = {
    id: "sanctum.moods",
    name: "Moods",
    state: "paused",
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
  } as unknown as AppInfo;
  const movieMood = {
    ...movie,
    graph: graph([
      { id: "t", kind: "trigger", piece: "manual", config: {} },
      {
        id: "s",
        kind: "step",
        app: "sanctum.moods",
        piece: "moods.runMood",
        config: { id: "aurora" },
      },
    ]),
  };

  async function showWith(page: string, opened: string[] = []) {
    workflows = [movieMood];
    await act(async () =>
      root.render(
        <AutomationsPage
          page={page}
          params={{ id: "movie" }}
          open={() => {}}
          back={() => {}}
          apps={[paused]}
          devices={
            { places, devices } as unknown as ReturnType<typeof useDevices>
          }
          live={createLiveFeed()}
          openAppSettings={(app) => opened.push(app)}
          openStatus={() => opened.push("status")}
          ask={async () => true}
        />,
      ),
    );
  }

  it("says why in the list, where Run can't be pressed", async () => {
    await showWith("main");
    expect(container.textContent).toContain("Can't run while Moods is paused");
    expect(
      buttons(container).find((each) => each.textContent === "Run"),
    ).toHaveProperty("disabled", true);
  });

  it("says on its page where to fix it", async () => {
    const opened: string[] = [];
    await showWith("automation", opened);
    expect(container.textContent).toContain(
      "It can't run while Moods is pausedMoods needs “Control your lights”. Turn it back on in Moods settings.",
    );
    expect(
      buttons(container).find((each) => each.textContent === "Run")?.disabled,
    ).toBe(true);
    await press("Open Moods settings", container);
    expect(opened).toEqual(["sanctum.moods"]);
  });
});

describe("the editor", () => {
  it("updates a device's capability when the device changes in All options", async () => {
    availablePieces = [
      ...pieces,
      {
        kind: "step",
        app: null,
        id: "device",
        title: "Command a device",
        sentence: "Turn on {device}",
        icon: null,
        card: null,
        group: null,
        presets: [],
        needs: [],
        config: {
          properties: {
            device: { type: "string", names: "device" },
            capability: { type: "string", partOf: "device" },
            command: { type: "object" },
          },
          required: ["device", "capability", "command"],
        },
      },
    ];
    homeDevices = [
      ...devices,
      {
        ...devices[1]!,
        id: "desk",
        name: "Office desk",
        capabilities: [{ ...devices[1]!.capabilities[0]!, id: "desk-light" }],
      },
    ];
    workflows = [
      {
        ...movie,
        graph: graph([
          movie.graph.nodes[0]!,
          {
            id: "s",
            kind: "step",
            piece: "device",
            config: {
              device: "ceiling",
              capability: "light",
              command: { on: true },
            },
          },
        ]),
      },
    ];
    await show("edit", { id: "movie" });
    const more = container.querySelector<HTMLButtonElement>(
      '[aria-label="Turn on Office ceiling: more"]',
    )!;
    await act(async () =>
      more.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    const allOptions =
      document.querySelector<HTMLElement>('[role="menuitem"]')!;
    await act(async () => allOptions.click());
    await press("Office desk");
    await press("Done");
    await press("Save");
    expect(coreJson).toHaveBeenCalledWith("/api/workflows/update", {
      method: "POST",
      json: expect.objectContaining({
        graph: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              config: {
                device: "desk",
                capability: "desk-light",
                command: { on: true },
              },
            }),
          ]),
        }),
      }),
    });
  });

  it("saves what is built from Add, once it has a trigger and a step", async () => {
    await show("edit");
    expect(container.textContent).toContain("Add a trigger and a step to save");
    await press("Add a trigger");
    await press("At sunset");
    expect(container.textContent).toContain("At sunset, on the dot");
    expect(container.textContent).toContain("Add a step to save");

    await press("Add a step");
    await press("Turn on the lights in Office");
    const save = buttons(container).find(
      (each) => each.textContent === "Save",
    )!;
    expect(save.disabled).toBe(false);
    await act(async () => save.click());

    const added = vi
      .mocked(coreJson)
      .mock.calls.find(([path]) => path === "/api/workflows/add")![1]!.json as {
      name: string;
      graph: WorkflowGraph;
    };
    expect(added.name).toBe("At sunset");
    expect(
      added.graph.nodes.map((node) => [node.kind, node.piece, node.config]),
    ).toEqual([
      ["trigger", "sun", { event: "sunset" }],
      ["step", "lights", { to: "on", place: { kind: "room", id: "office" } }],
    ]);
    expect(added.graph.edges).toEqual([
      { from: added.graph.nodes[0]!.id, to: added.graph.nodes[1]!.id },
    ]);
    expect(routes.at(-1)?.page).toBe("back");
  });

  it("lists each press a remote knows in Add", async () => {
    await show("edit");
    await press("Add a trigger");
    const entries = [
      ...document.querySelectorAll('[role="dialog"] button'),
    ].map((each) => each.textContent);
    expect(entries).toContain("Single press on Office button");
    expect(entries).toContain("Double press on Office button");
  });

  it("binds each press in Add to the button it's on", async () => {
    devices.push({
      id: "dimmer",
      name: "Dimmer",
      roomId: "office",
      capabilities: [
        { id: "top", kind: "button", features: { actions: ["on"], holds: [] } },
        {
          id: "bottom",
          kind: "button",
          features: { actions: ["off"], holds: [] },
        },
      ],
    } as never);
    try {
      await show("edit");
      await press("Add a trigger");
      await press("Off on Dimmer");
      await press("Add a step");
      await press("Turn on the lights in Office");
      await act(async () =>
        buttons(container)
          .find((each) => each.textContent === "Save")!
          .click(),
      );
      const added = vi
        .mocked(coreJson)
        .mock.calls.find(([path]) => path === "/api/workflows/add")![1]!
        .json as { graph: WorkflowGraph };
      expect(added.graph.nodes[0]!.config).toEqual({
        device: "dimmer",
        capability: "bottom",
        action: "off",
      });
    } finally {
      devices.pop();
    }
  });

  it("has Try the steps, disabled", async () => {
    await show("edit");
    const tryIt = buttons(container).find(
      (each) => each.textContent === "Try the steps",
    )!;
    expect(tryIt.disabled).toBe(true);
    expect(container.textContent).toContain("Not available in this version");
  });
});

describe("the editor's motion and light pieces", () => {
  const office = { kind: "room", id: "office" };
  const motionLights = workflow({
    id: "motion",
    name: "Office lights with motion",
    graph: {
      version: 1,
      nodes: [
        {
          id: "t",
          kind: "trigger",
          piece: "motion",
          config: { place: office },
        },
        {
          id: "c",
          kind: "condition",
          piece: "lightLevel",
          config: { place: office, is: "darker", lux: 30 },
        },
        {
          id: "s",
          kind: "step",
          piece: "lights",
          config: { place: office, to: "on" },
        },
      ],
      edges: [
        { from: "t", to: "c" },
        { from: "c", to: "s" },
      ],
    },
  });

  beforeEach(() => {
    availablePieces = [...pieces, ...motionPieces];
    homeDevices = [...devices, motionSensor];
  });

  const token = (text: string) =>
    buttons(container).find((each) => each.textContent === text)!;
  const openToken = async (text: string) => {
    await act(async () => token(text).click());
    return document.querySelector<HTMLElement>("[data-slot=popover-content]")!;
  };
  const saved = () =>
    (
      vi
        .mocked(coreJson)
        .mock.calls.filter(([path]) => path === "/api/workflows/update")
        .at(-1)![1]!.json as { graph: WorkflowGraph }
    ).graph.nodes;

  it("changes a light level from its usual ones, saying what the place reads now", async () => {
    workflows = [motionLights];
    await show("edit", { id: "motion" });
    expect(container.textContent).toContain("Motion in Office");
    expect(container.textContent).toContain("Office is darker than 30 lx");

    const popover = await openToken("30 lx");
    expect(
      [...popover.querySelectorAll("button")].map((each) => each.textContent),
    ).toEqual(["5 lx", "10 lx", "30 lx", "50 lx", "100 lx", "Done"]);
    expect(popover.textContent).toContain("Office reads 320 lx now");
    await press("50 lx", popover);
    await press("Done", popover);
    expect(container.textContent).toContain("Office is darker than 50 lx");

    await press("Save");
    expect(saved().find((node) => node.id === "c")!.config).toEqual({
      place: office,
      is: "darker",
      lux: 50,
    });
  });

  it("leaves out what a place reads when none of its sensors does", async () => {
    homeDevices = devices;
    workflows = [motionLights];
    await show("edit", { id: "motion" });
    const popover = await openToken("30 lx");
    expect(popover.textContent).not.toContain("reads");
  });

  it("types how long there's been no motion, or picks a usual length", async () => {
    workflows = [
      {
        ...motionLights,
        graph: graph([
          {
            id: "t",
            kind: "trigger",
            piece: "noMotion",
            config: { place: office, forMinutes: 10 },
          },
          motionLights.graph.nodes[2]!,
        ]),
      },
    ];
    await show("edit", { id: "motion" });
    expect(container.textContent).toContain(
      "No motion in Office for 10 minutes",
    );
    const popover = await openToken("10 minutes");
    expect(
      [...popover.querySelectorAll("button")].map((each) => each.textContent),
    ).toEqual([
      "2 min",
      "5 min",
      "10 min",
      "15 min",
      "30 min",
      "60 min",
      "Done",
    ]);
    const input = popover.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "25");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain(
      "No motion in Office for 25 minutes",
    );
    // Out of its range, it isn't taken.
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "500");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain(
      "No motion in Office for 25 minutes",
    );
  });

  it("offers a room's motion, its motion sensor and its light level in Add", async () => {
    await show("edit");
    await press("Add a trigger");
    const entries = () =>
      [...document.querySelectorAll('[role="dialog"] button')].map(
        (each) => each.textContent,
      );
    expect(entries()).toContain("Motion in Office");
    expect(entries()).toContain("No motion in Office for Choose how long");
    expect(entries()).toContain("Office motion sensor detects motion");
    expect(
      [...document.querySelectorAll('[role="dialog"] h3')].map(
        (each) => each.textContent,
      ),
    ).toContain("Motion");
    await press("Motion in Office");

    await press("Add a condition");
    expect(entries()).toContain("Office motion sensor sees motion");
    expect(entries()).toContain("Office is darker than Choose a light level");
    expect(entries()).not.toContain("Office ceiling sees motion");
  });
});

describe("an automation's history", () => {
  function run(overrides: Partial<WorkflowRunInfo> = {}): WorkflowRunInfo {
    return {
      id: "run",
      workflowId: "movie",
      version: 1,
      status: "succeeded",
      trigger: { nodes: ["t"], key: null, data: {} },
      startedBy: null,
      startedOn: "Kitchen tablet",
      reason: null,
      error: null,
      queuedAt: "2026-10-30T08:00:00.000Z",
      startedAt: "2026-10-30T08:00:00.000Z",
      endedAt: "2026-10-30T08:00:01.000Z",
      steps: [
        {
          node: "s",
          kind: "step",
          app: null,
          piece: "lights",
          status: "succeeded",
          input: { place: { kind: "room", id: "office" }, to: "on" },
          output: null,
          error: null,
          startedAt: "2026-10-30T08:00:00.000Z",
          endedAt: "2026-10-30T08:00:01.000Z",
        },
      ],
      ...overrides,
    };
  }

  it("describes recorded steps after their config or node has changed", async () => {
    workflows = [{ ...movie, version: 2 }];
    runs = [run()];
    await show("automation", { id: "movie" });
    expect(container.querySelector("ol")?.textContent).toContain(
      "Turn on the lights in Office",
    );
    expect(container.querySelector("ol")?.textContent).not.toContain(
      "whole home",
    );

    workflows = [
      {
        ...movie,
        version: 3,
        graph: graph(movie.graph.nodes.filter((node) => node.id !== "s")),
      },
    ];
    await show("automation", { id: "movie" });
    expect(container.querySelector("ol")?.textContent).toContain(
      "Turn on the lights in Office",
    );
  });

  it("refreshes an active run until it finishes, then stops polling", async () => {
    vi.useFakeTimers();
    workflows = [
      {
        ...movie,
        graph: graph([
          ...movie.graph.nodes,
          { ...movie.graph.nodes[1]!, id: "later" },
        ]),
      },
    ];
    runs = [run({ status: "running", endedAt: null })];
    await show("automation", { id: "movie" });
    expect(container.textContent).toContain("Running");
    expect(container.querySelector("ol")?.textContent).not.toContain(
      "Not reached",
    );
    runs = [run()];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(container.textContent).toContain("Run on Kitchen tablet");
    const requests = vi.mocked(coreJson).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(vi.mocked(coreJson).mock.calls).toHaveLength(requests);
  });

  it("keeps a failed action visible when history refreshes", async () => {
    vi.useFakeTimers();
    runs = [run({ status: "running", endedAt: null })];
    await show("automation", { id: "movie" });
    vi.mocked(coreJson).mockRejectedValueOnce(new Error("Disconnected"));
    await press("Run");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
