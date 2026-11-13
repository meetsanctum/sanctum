import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadAppPackage } from "./runner-apps.js";
import { lampsCore, radio, settled } from "./devices-support.js";
import { get, post, sharedClient, type TestCore } from "./support.js";

// What each press of a remote does, end to end: Moods keeps a workflow for each
// press the household chooses, and for a remote in a room one for the presses
// it has not chosen, which switch the room's lights and whose hold brightens or
// dims them while it lasts.

async function home() {
  const moods = await loadAppPackage(
    fileURLToPath(new URL("../../../catalog/apps/moods", import.meta.url)),
    "official",
  );
  const { core, maya, lamp } = await lampsCore({ apps: [moods] });
  await radio.add("remote-1", "button", "Wireless mini switch");
  await settled();
  const token = maya.token;
  const devices = (await get(core, "/api/devices", { token })).json() as {
    id: string;
    driverName: string;
  }[];
  const remote = devices.find(
    (each) => each.driverName === "Wireless mini switch",
  )!.id;
  const office = (
    await post(core, "/api/places/rooms/add", { name: "Office" }, { token })
  ).json() as { id: string };
  for (const id of [lamp, remote]) {
    await post(core, "/api/devices/update", { id, roomId: office.id }, maya);
  }
  // Moods hears the remote is in a room, and keeps its presses' workflow.
  await expect.poll(() => kept(core, maya)).toHaveLength(1);
  return { core, maya, lamp, remote, office };
}

type Home = Awaited<ReturnType<typeof home>>;

function moods(
  core: TestCore,
  maya: Home["maya"],
  action: string,
  input: object,
) {
  return post(core, `/api/apps/sanctum.moods/actions/${action}`, input, maya);
}

// The lamp's on and off, as it last told the core.
function lampIsOn(core: TestCore, lamp: string) {
  const light = core.devices
    .get(lamp)!
    .capabilities.find((each) => each.kind === "light")!;
  return light.state && "on" in light.state ? light.state.on : undefined;
}

async function press(core: TestCore, action: string) {
  await radio.pressButton("remote-1", action);
  await core.workflows.settled();
  await settled();
}

async function kept(core: TestCore, maya: Home["maya"]) {
  return (
    (await get(core, "/api/workflows", { token: maya.token })).json() as {
      name: string;
      app: string | null;
      appKey: string | null;
    }[]
  ).filter((each) => each.app === "sanctum.moods");
}

describe("a remote's presses", () => {
  it("switch its room's lights while they are not chosen, and a hold dims them", async () => {
    const { core, maya, lamp, remote, office } = await home();

    expect(await kept(core, maya)).toEqual([
      expect.objectContaining({
        name: "Office button: presses not chosen",
        appKey: `default:${remote}`,
      }),
    ]);
    const toggle = {
      kind: "lights",
      place: { kind: "room", id: office.id },
      to: "toggle",
    };
    expect(
      (await moods(core, maya, "moods.presses", { device: remote })).json(),
    ).toEqual({
      presses: [
        { action: "single", choice: null, default: toggle, hold: false },
        { action: "double", choice: null, default: toggle, hold: false },
        {
          action: "hold",
          choice: null,
          default: { ...toggle, to: "brightenOrDimWhileHeld" },
          hold: true,
        },
      ],
      defaults: { roomId: office.id, dimmer: false },
    });
    await press(core, "single");
    await expect.poll(() => lampIsOn(core, lamp)).toBe(true);
    await press(core, "double");
    await expect.poll(() => lampIsOn(core, lamp)).toBe(false);

    // The lamp is on at full, so the first hold dims it, until let go.
    await press(core, "single");
    await expect.poll(() => lampIsOn(core, lamp)).toBe(true);
    await press(core, "hold");
    await expect
      .poll(() => radio.moves.map(({ move }) => move.move))
      .toEqual([{ move: "down", percentPerSecond: 25 }]);
    core.advance(2_000);
    await radio.releaseButton("remote-1");
    await expect
      .poll(() => radio.moves.at(-1)!.move.move)
      .toEqual({ move: "stop" });
    const shown = () =>
      core.devices
        .get(lamp)!
        .capabilities.find((each) => each.kind === "light")!.state;
    await expect.poll(shown).toMatchObject({ on: true, brightness: 50 });
  });

  it("do what is chosen for each, and the others their default", async () => {
    const { core, maya, lamp, remote, office } = await home();
    const mood = (
      await moods(core, maya, "moods.createMood", {
        roomId: office.id,
        name: "Evening",
        lights: [
          {
            device: lamp,
            capability: "light",
            state: { on: true, brightness: 30, colorTemperature: 400 },
          },
        ],
      })
    ).json() as { id: string };

    const chosen = await moods(core, maya, "moods.choosePress", {
      device: remote,
      action: "double",
      choice: { kind: "mood", moodId: mood.id },
    });
    expect(
      chosen
        .json()
        .presses.map((each: { action: string; choice: unknown }) => [
          each.action,
          each.choice,
        ]),
    ).toEqual([
      ["single", null],
      ["double", { kind: "mood", moodId: mood.id }],
      ["hold", null],
    ]);
    expect((await kept(core, maya)).map((each) => each.appKey).sort()).toEqual([
      `default:${remote}`,
      `press:${remote}:double`,
    ]);

    await moods(core, maya, "moods.choosePress", {
      device: remote,
      action: "single",
      choice: { kind: "nothing" },
    });
    await press(core, "single");
    expect(lampIsOn(core, lamp)).not.toBe(true);
    await press(core, "double");
    const shown = core.devices
      .get(lamp)!
      .capabilities.find((each) => each.kind === "light")!.state;
    expect(shown).toMatchObject({ on: true, brightness: 30 });
  });

  it("can be set to do nothing, or to switch other lights, and taken back", async () => {
    const { core, maya, lamp, remote } = await home();

    for (const action of ["single", "double", "hold"]) {
      await moods(core, maya, "moods.choosePress", {
        device: remote,
        action,
        choice: { kind: "nothing" },
      });
    }
    expect(await kept(core, maya)).toEqual([]);
    await press(core, "single");
    expect(lampIsOn(core, lamp)).not.toBe(true);

    await moods(core, maya, "moods.choosePress", {
      device: remote,
      action: "hold",
      choice: { kind: "lights", place: { kind: "home" }, to: "toggle" },
    });
    await press(core, "hold");
    expect(lampIsOn(core, lamp)).toBe(true);

    for (const action of ["single", "double", "hold"]) {
      await moods(core, maya, "moods.choosePress", {
        device: remote,
        action,
        choice: null,
      });
    }
    expect((await kept(core, maya)).map((each) => each.appKey)).toEqual([
      `default:${remote}`,
    ]);
  });

  it("refuse a press the remote does not have, or a mood that is not there", async () => {
    const { core, maya, remote, lamp } = await home();

    for (const input of [
      { device: remote, action: "triple", choice: { kind: "nothing" } },
      {
        device: remote,
        action: "single",
        choice: { kind: "mood", moodId: "no-such-mood" },
      },
      { device: lamp, action: "single", choice: { kind: "nothing" } },
    ]) {
      expect(
        (await moods(core, maya, "moods.choosePress", input)).json(),
      ).toEqual({ error: "not_found" });
    }
  });

  it("follow their remote, its room and the mood they run", async () => {
    const { core, maya, lamp, remote, office } = await home();
    const mood = (
      await moods(core, maya, "moods.createMood", {
        roomId: office.id,
        name: "Evening",
        lights: [
          {
            device: lamp,
            capability: "light",
            state: { on: true, brightness: 30 },
          },
        ],
      })
    ).json() as { id: string };
    await moods(core, maya, "moods.choosePress", {
      device: remote,
      action: "double",
      choice: { kind: "mood", moodId: mood.id },
    });

    // The mood goes, and with it the only choice: every press switches the
    // room again.
    await moods(core, maya, "moods.deleteMood", { id: mood.id });
    expect((await kept(core, maya)).map((each) => each.appKey)).toEqual([
      `default:${remote}`,
    ]);

    // In no room, there is no room to switch.
    await post(core, "/api/devices/update", { id: remote, roomId: null }, maya);
    await expect.poll(() => kept(core, maya)).toEqual([]);

    await post(
      core,
      "/api/devices/update",
      { id: remote, roomId: office.id },
      maya,
    );
    await expect.poll(() => kept(core, maya)).toHaveLength(1);
    await post(core, "/api/devices/remove", { id: remote, force: true }, maya);
    await expect.poll(() => kept(core, maya)).toEqual([]);
  });

  it("keeps valid long names and press actions within workflow limits", async () => {
    const { core, maya, lamp, remote, office } = await home();
    const name = "Remote".repeat(20);
    await post(core, "/api/devices/update", { id: remote, name }, maya);
    await expect
      .poll(async () => (await kept(core, maya))[0]?.name)
      .toBe(`${name.slice(0, 100)}: presses not chosen`);

    const action = "a".repeat(64);
    core.devices.register("test.lamps", {
      key: "remote-1",
      name: "Wireless mini switch",
      capabilities: [
        { id: "button", kind: "button", features: { actions: [action] } },
      ],
    });
    await settled();
    const chosen = await moods(core, maya, "moods.choosePress", {
      device: remote,
      action,
      choice: {
        kind: "lights",
        place: { kind: "room", id: office.id },
        to: "toggle",
      },
    });
    expect(chosen.statusCode).toBe(200);
    const workflows = await kept(core, maya);
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.name.length).toBeLessThanOrEqual(120);
    expect(workflows[0]?.name.endsWith(`: ${action}`)).toBe(true);
    expect(workflows[0]?.appKey).toBe(`press:${remote}:${action}`);
    await press(core, action);
    await expect.poll(() => lampIsOn(core, lamp)).toBe(true);
  });

  it("keeps another remote's choices when a shared client chooses a press", async () => {
    const { core, maya, lamp, remote, office } = await home();
    await moods(core, maya, "moods.choosePress", {
      device: remote,
      action: "double",
      choice: {
        kind: "lights",
        place: { kind: "room", id: office.id },
        to: "toggle",
      },
    });
    const other = core.devices.register("test.lamps", {
      key: "shared-remote",
      name: "Shared remote",
      capabilities: [
        { id: "button", kind: "button", features: { actions: ["single"] } },
      ],
    });
    await settled();
    const shared = sharedClient(core);
    const chosen = await post(
      core,
      "/api/apps/sanctum.moods/actions/moods.choosePress",
      {
        device: other.id,
        action: "single",
        choice: { kind: "nothing" },
      },
      shared,
    );
    expect(chosen.statusCode).toBe(200);
    expect((await kept(core, maya)).map((each) => each.appKey)).toContain(
      `press:${remote}:double`,
    );
    const listing = (
      await moods(core, maya, "moods.presses", { device: remote })
    ).json();
    expect(
      listing.presses.find(
        (each: { action: string }) => each.action === "double",
      ).choice.kind,
    ).toBe("lights");
    await press(core, "double");
    expect(lampIsOn(core, lamp)).toBe(true);
  });

  it("are held back while someone finds a press, the default toggle too", async () => {
    const { core, maya, lamp, remote } = await home();
    const capture = (
      await post(core, "/api/devices/capture/start", { device: remote }, maya)
    ).json() as { id: string };

    await press(core, "single");
    expect(lampIsOn(core, lamp)).not.toBe(true);

    await post(core, "/api/devices/capture/stop", { id: capture.id }, maya);
    await press(core, "single");
    await expect.poll(() => lampIsOn(core, lamp)).toBe(true);
  });
});
