import { describe, expect, it } from "vitest";

import { byHand, curveAt, lamp, off, on, running } from "./running.js";

// What natural light sends a light goes by whether it read the light as on.
// A light someone switches between that reading and the command keeps what
// they asked: the look a light that is off comes back at never switches one
// off, and a look for a light that is on never turns one back on.

// Has the first command find the light switched by hand a moment before.
function switchedBeforeCommand(
  core: ReturnType<typeof running>["core"],
  to: boolean,
) {
  let isSwitched = false;
  core.state.beforeCommand = async () => {
    if (isSwitched) return;
    isSwitched = true;
    core.set("lamp", { on: to }, byHand);
  };
}

describe("a light switched while natural light was about to set it", () => {
  it("stays on when it was read as off, and takes the curve", async () => {
    const { core, call, now, sentFrom } = running();
    core.addLight("lamp", "Office light", { ...off, colorTemperature: 400 });
    switchedBeforeCommand(core, true);

    await call("naturalLight.follow", { ...lamp, follow: true });

    expect(sentFrom(0)).toEqual([curveAt(now())]);
    expect(core.light("lamp").state).toMatchObject({
      on: true,
      ...curveAt(now()),
    });
  });

  it("stays off when it was read as on, and comes back at the curve", async () => {
    const { core, call, now, sentFrom } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 400 });
    switchedBeforeCommand(core, false);

    await call("naturalLight.follow", { ...lamp, follow: true });

    expect(sentFrom(0)).toEqual([{ on: false, ...curveAt(now()) }]);
    expect(core.light("lamp").state).toMatchObject({ on: false });
  });

  it("stays on when natural light lets go of it as it stops following", async () => {
    const { core, call, sentFrom } = running();
    core.addLight("lamp", "Office light", { ...off, colorTemperature: 400 });
    await call("naturalLight.follow", { ...lamp, follow: true });
    const sent = core.state.sent.length;
    switchedBeforeCommand(core, true);

    await call("naturalLight.follow", { ...lamp, follow: false });

    expect(sentFrom(sent)).toEqual([]);
    expect(core.light("lamp").state).toMatchObject({ on: true });
  });
});
