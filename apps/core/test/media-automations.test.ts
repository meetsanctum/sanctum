import type { WorkflowNode } from "@meetsanctum/app-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lampsCore, radio, settled } from "./devices-support.js";
import { claimed, get, post, testCore, type TestCore } from "./support.js";
import {
  addWorkflow,
  runByHand,
  runsOf,
  steps,
  trigger,
} from "./workflows-support.js";

// Media players in automations: a workflow starts as one starts playing,
// pauses or stops playing, where a player loading in the middle of playing
// is still playing and a stop counts once it has held five seconds. It may
// ask whether one is playing, and resume, pause, stop, mute and unmute one or
// set its volume, each only on a player that can, at save and before a run.
// Pause and Resume with nothing to act on send nothing.

const lightsOn: WorkflowNode = {
  id: "on",
  kind: "step",
  piece: "lights",
  config: { place: { kind: "home" }, to: "on" },
};

const presetsOf = async (core: TestCore, token: string, kind: string) =>
  (
    (await get(core, "/api/workflows/pieces", { token })).json() as {
      kind: string;
      app: string | null;
      id: string;
      presets: { title: string; config: object }[];
    }[]
  )
    .find(
      (each) => each.kind === kind && each.app === null && each.id === "device",
    )!
    .presets.map((preset) => [preset.title, preset.config]);

async function home() {
  const context = await lampsCore();
  await radio.add("box-1", "media", "Living room box");
  await settled();
  const devices = (
    await get(context.core, "/api/devices", { token: context.maya.token })
  ).json();
  const player = devices.find(
    (each: { driverName: string }) => each.driverName === "Living room box",
  ).id as string;
  return { ...context, token: context.maya.token, player };
}

async function say(state: Record<string, unknown>) {
  await radio.press("box-1", state);
  await settled();
}

function registerPlayer(core: TestCore, capabilities = ["media"]) {
  const driver = "sanctum.example";
  const key = "player";
  const { id } = core.devices.register(driver, {
    key,
    name: "Player",
    type: "media-player",
    capabilities: capabilities.map((id) => ({
      id,
      kind: "media",
      features: {},
    })),
  });
  return {
    id,
    report: (states: Record<string, { activity: string }>) =>
      core.devices.report(driver, { key, states }),
  };
}

async function playbackHome() {
  const core = await testCore();
  const { token } = await claimed(core);
  const { id: player, report } = registerPlayer(core);
  const say = (activity: string) => report({ media: { activity } });
  say("idle");
  return { core, token, player, say };
}

// A workflow that starts on one of the device trigger's media presets.
async function startsWhen(
  core: TestCore,
  token: string,
  player: string,
  title: string,
) {
  const config = Object.fromEntries(
    (await presetsOf(core, token, "trigger")).filter(
      ([each]) => each === title,
    ),
  )[title];
  const { id } = await addWorkflow(core, token, {
    graph: steps(
      trigger("player", "device", {
        device: player,
        capability: "media",
        ...(config as object),
      }),
      lightsOn,
    ),
  });
  return id;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the device pieces' words for a media player", () => {
  it("offer starts playing, pauses and stops playing, is playing and isn't, and the player's steps", async () => {
    const { core, token } = await home();

    expect(await presetsOf(core, token, "trigger")).toEqual(
      expect.arrayContaining([
        [
          "Starts playing",
          {
            kind: "media",
            field: "activity",
            operator: "equals",
            value: "playing",
            fromKnown: true,
            loadingIsPlaying: true,
          },
        ],
        [
          "Pauses",
          {
            kind: "media",
            field: "activity",
            operator: "equals",
            value: "paused",
            fromKnown: true,
          },
        ],
        [
          "Stops playing",
          {
            kind: "media",
            field: "activity",
            operator: "equals",
            value: "idle",
            fromKnown: true,
            forSeconds: 5,
          },
        ],
      ]),
    );
    expect(await presetsOf(core, token, "condition")).toEqual(
      expect.arrayContaining([
        [
          "Is playing",
          {
            field: "activity",
            operator: "equals",
            value: "playing",
            loadingIsPlaying: true,
          },
        ],
        [
          "Isn't playing",
          {
            field: "activity",
            operator: "not_equals",
            value: "playing",
            loadingIsPlaying: true,
          },
        ],
      ]),
    );
    expect(await presetsOf(core, token, "step")).toEqual(
      expect.arrayContaining([
        ["Resume", { command: { activity: "playing" }, resumeOnly: true }],
        ["Pause", { command: { activity: "paused" } }],
        ["Stop", { command: { playback: "stop" } }],
        ["Mute", { command: { muted: true } }],
        ["Unmute", { command: { muted: false } }],
      ]),
    );
    const pieces = (await get(core, "/api/workflows/pieces", { token })).json();
    const volume = pieces.find(
      (each: { kind: string; app: string | null; id: string }) =>
        each.kind === "step" && each.app === null && each.id === "volume",
    );
    expect(volume).toMatchObject({
      sentence: "Set {device}'s volume to {volume}",
      presets: [{ config: { volume: 30 } }],
      config: {
        properties: {
          device: { names: "device", sends: { volume: 0 } },
          volume: { percent: true, minimum: 0, maximum: 100 },
        },
      },
    });
  });
});

describe("a workflow that starts when a player starts playing", () => {
  it("runs from stopped or paused, and not again as it loads in the middle", async () => {
    const { core, token, player, say } = await playbackHome();
    const id = await startsWhen(core, token, player, "Starts playing");

    say("playing");
    say("loading");
    say("playing");
    say("paused");
    say("playing");
    await core.workflows.settled();

    expect(await runsOf(core, token, id)).toHaveLength(2);
  });

  it("runs on a pause", async () => {
    const { core, token, player, say } = await playbackHome();
    const id = await startsWhen(core, token, player, "Pauses");

    say("playing");
    await core.workflows.settled();
    expect(await runsOf(core, token, id)).toHaveLength(0);
    say("paused");
    await core.workflows.settled();

    const runs = await runsOf(core, token, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger.data).toMatchObject({
      after: { activity: "paused" },
    });
  });

  it("can trigger explicitly on loading", async () => {
    const core = await testCore();
    const { token } = await claimed(core);
    const player = registerPlayer(core);
    const { id } = await addWorkflow(core, token, {
      graph: steps(
        trigger("player", "device", {
          device: player.id,
          capability: "media",
          field: "activity",
          operator: "equals",
          value: "loading",
        }),
        lightsOn,
      ),
    });
    player.report({ media: { activity: "playing" } });
    await core.workflows.settled();
    expect(await runsOf(core, token, id)).toHaveLength(0);

    player.report({ media: { activity: "loading" } });
    await core.workflows.settled();
    const [run] = await runsOf(core, token, id);
    expect(run?.trigger.data).toMatchObject({ after: { activity: "loading" } });
  });
});

describe("a workflow that starts when a player stops playing", () => {
  it("does not schedule a hold before workflows start", async () => {
    let finishStaging!: () => void;
    const staged = new Promise<void>((resolve) => (finishStaging = resolve));
    try {
      const core = await testCore({ staged });
      const player = registerPlayer(core);
      const { id } = core.workflows.add(
        { clientId: "example" },
        {
          name: "When playback stops",
          enabled: true,
          runMode: "single",
          graph: steps(
            trigger("player", "device", {
              device: player.id,
              field: "activity",
              operator: "equals",
              value: "idle",
              fromKnown: true,
              forSeconds: 5,
            }),
            lightsOn,
          ),
        },
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      for (const activity of ["playing", "idle"]) {
        player.report({ media: { activity } });
      }
      vi.advanceTimersByTime(5_000);
      await core.workflows.settled();
      expect(core.workflows.runs(id)).toEqual([]);
    } finally {
      finishStaging();
    }
  });

  it("runs once it has been stopped for five seconds", async () => {
    const { core, token, player, say } = await playbackHome();
    const id = await startsWhen(core, token, player, "Stops playing");
    say("playing");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    say("idle");
    vi.advanceTimersByTime(4_900);
    await core.workflows.settled();
    expect(await runsOf(core, token, id)).toHaveLength(0);

    vi.advanceTimersByTime(100);
    await core.workflows.settled();
    const runs = await runsOf(core, token, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger.data).toMatchObject({
      device: player,
      capability: "media",
      after: { activity: "idle" },
    });
  });

  it("waits five seconds from the second stop after playback resumes", async () => {
    const { core, token, player, say } = await playbackHome();
    const id = await startsWhen(core, token, player, "Stops playing");
    say("playing");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    say("idle");
    vi.advanceTimersByTime(2_000);
    say("loading");
    say("playing");
    say("idle");
    vi.advanceTimersByTime(3_000);
    await core.workflows.settled();
    expect(await runsOf(core, token, id)).toHaveLength(0);

    vi.advanceTimersByTime(2_000);
    await core.workflows.settled();
    expect(await runsOf(core, token, id)).toHaveLength(1);
  });

  it("forgets a pending stop when the workflow turns off and back on", async () => {
    const { core, token, player, say } = await playbackHome();
    const id = await startsWhen(core, token, player, "Stops playing");
    say("playing");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    say("idle");
    for (const enabled of [false, true]) {
      const response = await post(
        core,
        "/api/workflows/update",
        { id, enabled },
        { token },
      );
      expect(response.statusCode).toBe(200);
    }
    vi.advanceTimersByTime(5_000);
    await core.workflows.settled();

    expect(await runsOf(core, token, id)).toHaveLength(0);
  });

  it("forgets a pending stop when workflows are put on hold", async () => {
    const { core, token, player, say } = await playbackHome();
    const id = await startsWhen(core, token, player, "Stops playing");
    say("playing");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    say("idle");
    core.workflows.hold();
    vi.advanceTimersByTime(5_000);
    await core.workflows.settled();
    expect(await runsOf(core, token, id)).toHaveLength(0);
  });

  it("refuses a hold without a state field", async () => {
    const core = await testCore();
    const { token } = await claimed(core);
    const response = await post(
      core,
      "/api/workflows/add",
      {
        name: "Wait for a change",
        graph: steps(trigger("player", "device", { forSeconds: 5 }), lightsOn),
      },
      { token },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().problems).toContainEqual({
      node: "player",
      field: "forSeconds",
      message: "A hold needs a state field",
    });
  });

  it("fires both triggers together when the second player stays stopped", async () => {
    const core = await testCore();
    const { token } = await claimed(core);
    const { id: device, report: say } = registerPlayer(core, [
      "first",
      "second",
    ]);
    const report = (first: string, second: string) =>
      say({ first: { activity: first }, second: { activity: second } });
    report("playing", "playing");
    const config = {
      device,
      kind: "media",
      field: "activity",
      operator: "equals",
      value: "idle",
      fromKnown: true,
      forSeconds: 5,
    };
    const { id } = await addWorkflow(core, token, {
      runMode: "single",
      graph: {
        version: 1,
        nodes: [
          trigger("any", "device", config),
          trigger("specific", "device", { ...config, capability: "second" }),
          lightsOn,
        ],
        edges: [
          { from: "any", to: "on" },
          { from: "specific", to: "on" },
        ],
      },
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    report("idle", "idle");
    vi.advanceTimersByTime(2_000);
    report("playing", "idle");
    vi.advanceTimersByTime(3_000);
    await core.workflows.settled();
    const runs = await runsOf(core, token, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger: {
        nodes: ["any", "specific"],
        data: { device, capability: "second" },
      },
      steps: [{ node: "on", status: "succeeded" }],
    });
  });
});

describe("asking whether a player is playing", () => {
  async function passes(
    core: TestCore,
    token: string,
    player: string,
    title: "Is playing" | "Isn't playing",
  ) {
    const config = Object.fromEntries(
      await presetsOf(core, token, "condition"),
    )[title] as object;
    const { id } = await addWorkflow(core, token, {
      graph: {
        version: 1,
        nodes: [
          trigger("hand", "manual"),
          {
            id: "if",
            kind: "condition",
            piece: "device",
            config: { device: player, capability: "media", ...config },
          },
          lightsOn,
        ],
        edges: [
          { from: "hand", to: "if" },
          { from: "if", to: "on" },
        ],
      },
    });
    await runByHand(core, token, id);
    await core.workflows.settled();
    const [run] = await runsOf(core, token, id);
    return run!.status === "succeeded";
  }

  it("counts a player loading as playing", async () => {
    const { core, token, player } = await home();

    expect(await passes(core, token, player, "Is playing")).toBe(false);
    expect(await passes(core, token, player, "Isn't playing")).toBe(true);
    await say({ activity: "loading" });
    expect(await passes(core, token, player, "Is playing")).toBe(true);
    expect(await passes(core, token, player, "Isn't playing")).toBe(false);
    await say({ activity: "paused" });
    expect(await passes(core, token, player, "Isn't playing")).toBe(true);
  });
});

describe("a player's steps", () => {
  async function runs(
    core: TestCore,
    token: string,
    node: Omit<WorkflowNode, "id" | "kind">,
    ...later: WorkflowNode[]
  ) {
    const { id } = await addWorkflow(core, token, {
      graph: steps(
        trigger("hand", "manual"),
        {
          id: "step",
          kind: "step",
          ...node,
        },
        ...later,
      ),
    });
    await runByHand(core, token, id);
    await core.workflows.settled();
    const [run] = await runsOf(core, token, id);
    return run!;
  }
  const commands = () =>
    radio.received
      .filter((each) => each.command.kind === "media")
      .map((each) => each.command.command as object);

  it("pause a player that's playing, and skip one with nothing playing", async () => {
    const { core, token, player } = await home();
    const pause = {
      piece: "device",
      config: {
        device: player,
        capability: "media",
        command: { activity: "paused" },
      },
    };

    const idle = await runs(core, token, pause, lightsOn);
    expect(idle.status).toBe("succeeded");
    expect(idle.steps[0]).toMatchObject({
      status: "skipped",
      error: "Nothing was playing",
    });
    expect(commands()).toEqual([]);
    expect(idle.steps[1]).toMatchObject({ node: "on", status: "succeeded" });
    expect(radio.received.map(({ command }) => command.key)).toContain(
      "lamp-1",
    );

    await say({ activity: "playing" });
    const playing = await runs(core, token, pause);
    expect(playing.steps[0]).toMatchObject({ status: "succeeded" });
    expect(commands()).toEqual([{ activity: "paused" }]);
  });

  it("resume only a paused player", async () => {
    const { core, token, player } = await home();
    const resume = {
      piece: "device",
      config: {
        device: player,
        capability: "media",
        command: { activity: "playing" },
        resumeOnly: true,
      },
    };

    expect((await runs(core, token, resume)).steps[0]).toMatchObject({
      status: "skipped",
      error: "Nothing was paused",
    });
    await say({ activity: "paused" });
    expect((await runs(core, token, resume)).steps[0]).toMatchObject({
      status: "succeeded",
    });
    expect(commands()).toEqual([{ activity: "playing" }]);
  });

  it("waits for a reported pause before resuming and still sends a plain Play command", async () => {
    const { core, token, player } = await home();
    const { id: unreported } = core.devices.register("test.lamps", {
      key: "unreported",
      name: "Unreported player",
      type: "media-player",
      capabilities: [
        { id: "media", kind: "media", features: { playback: ["play"] } },
      ],
    });
    const command = { activity: "playing" };
    const step = {
      piece: "device",
      config: { device: player, capability: "media", command },
    };
    const resume = await runs(core, token, {
      ...step,
      config: { ...step.config, device: unreported, resumeOnly: true },
    });
    expect(resume.steps[0]).toMatchObject({
      status: "skipped",
      error: "Nothing was paused",
    });
    expect(commands()).toEqual([]);

    const play = await runs(core, token, step);
    expect(play.steps[0]).toMatchObject({ status: "succeeded" });
    expect(commands()).toEqual([command]);
  });

  it("set a player's volume", async () => {
    const { core, token, player } = await home();

    const run = await runs(core, token, {
      piece: "volume",
      config: { device: player, capability: "media", volume: 20 },
    });

    expect(run.steps[0]).toMatchObject({ status: "succeeded" });
    expect(commands()).toEqual([{ volume: 20 }]);
  });
});

describe("a player's step it can't do", () => {
  // A smart speaker with no power, as a Voice PE has, and mute while it
  // says it has.
  function speaker(core: TestCore, mute: boolean) {
    core.devices.register("test.lamps", {
      key: "speaker-1",
      name: "Speaker",
      type: "smart-speaker",
      capabilities: [
        {
          id: "media",
          kind: "media",
          features: {
            power: false,
            playback: ["play", "pause", "stop"],
            volume: "level",
            mute,
          },
        },
      ],
    });
  }
  async function speakerOf(core: TestCore, token: string) {
    const devices = (await get(core, "/api/devices", { token })).json();
    return devices.find(
      (each: { driverName: string }) => each.driverName === "Speaker",
    ).id as string;
  }

  it("is refused at save, with why on the device", async () => {
    const { core, token } = await home();
    speaker(core, true);
    const device = await speakerOf(core, token);

    const response = await post(
      core,
      "/api/workflows/add",
      {
        name: "Off",
        graph: steps(trigger("hand", "manual"), {
          id: "off",
          kind: "step",
          piece: "device",
          config: { device, capability: "media", command: { on: false } },
        }),
      },
      { token },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().problems).toEqual([
      { node: "off", field: "device", message: "Smart Speaker can't do this" },
    ]);
  });

  it("keeps a run from starting once its player registers without it", async () => {
    const { core, token } = await home();
    speaker(core, true);
    const device = await speakerOf(core, token);
    const { id } = await addWorkflow(core, token, {
      graph: steps(trigger("hand", "manual"), {
        id: "mute",
        kind: "step",
        piece: "device",
        config: { device, capability: "media", command: { muted: true } },
      }),
    });

    speaker(core, false);
    await runByHand(core, token, id);
    await core.workflows.settled();

    const [run] = await runsOf(core, token, id);
    expect(run).toMatchObject({
      status: "skipped",
      reason: "broken",
      error: "Smart Speaker can't do this",
    });
  });
});
