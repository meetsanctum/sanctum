import { describe, expect, it, vi } from "vitest";

import {
  action,
  appOnSocket,
  calls,
  gone,
  link,
  listening,
  logs,
  person,
  readyApp,
  useLink,
  welcomeHello,
} from "./app-link-support.js";

// While the host writes out a backlog to its disks, every fsync waits behind
// it, and an app whose database writes block its runner can't answer: it
// gets more time before it counts as hung, and only while that lasts.

useLink();

// The app answers every heartbeat, and nothing else.
function answeringBeats(app: Awaited<ReturnType<typeof appOnSocket>>) {
  let seen = 0;
  app.socket.on("data", () => {
    for (const message of app.heard.slice(seen)) {
      if (message.type === "ping")
        app.say({ type: "pong", beat: message.beat });
    }
    seen = app.heard.length;
  });
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const saying = (part: string) => logs.filter((line) => line.includes(part));

describe("an app's link while the host writes out", () => {
  it("spares an app that stops answering its heartbeat, says so once, and hears it again", async () => {
    await listening({
      heartbeatMs: 5,
      writeoutGraceMs: 10_000,
      isWritingOut: () => true,
    });
    const app = await readyApp();

    await pause(80);

    expect(gone).toEqual([]);
    expect(saying("hasn't answered its heartbeat while the host")).toEqual([
      "apps: test.link hasn't answered its heartbeat while the host writes out to its disks; it gets up to 10 s more",
    ]);

    app.say({ type: "pong", beat: 1 });
    await vi.waitFor(() =>
      expect(logs).toContain("apps: test.link answers again"),
    );
    expect(link.isReady()).toBe(true);
  });

  it("counts it as hung once its grace is over, though the host still writes out", async () => {
    await listening({
      heartbeatMs: 5,
      writeoutGraceMs: 50,
      isWritingOut: () => true,
    });
    await readyApp();

    await vi.waitFor(() =>
      expect(gone).toEqual([
        "it missed 3 heartbeats, and 10 more while the host wrote out to its disks",
      ]),
    );
  });

  it("counts it as hung a few beats after the host is done", async () => {
    let writing = true;
    await listening({
      heartbeatMs: 5,
      writeoutGraceMs: 10_000,
      isWritingOut: () => writing,
    });
    const app = await readyApp();
    await pause(60);
    expect(gone).toEqual([]);

    writing = false;

    await vi.waitFor(() => expect(gone).toHaveLength(1));
    expect(gone[0]).toMatch(/^it missed 3 heartbeats, and \d+ more while/);
    await vi.waitFor(() => expect(app.isClosed()).toBe(true));
  });

  it("still counts it as hung after three missed heartbeats while the host is idle", async () => {
    await listening({ heartbeatMs: 5, isWritingOut: () => false });
    await readyApp();

    await vi.waitFor(() => expect(gone).toEqual(["it missed 3 heartbeats"]));
    expect(saying("while the host")).toEqual([]);
  });

  it("lets a call stay busy past its grace while the host writes out, then counts it as hung", async () => {
    let writing = true;
    await listening({
      heartbeatMs: 5,
      graceMs: 20,
      writeoutGraceMs: 10_000,
      isWritingOut: () => writing,
    });
    const app = await readyApp();
    answeringBeats(app);
    const call = link.call(calls({}), person, action, 5).catch(() => "ended");
    await app.hearing("call");

    await pause(100);
    expect(gone).toEqual([]);
    expect(saying("still busy with a call")).toHaveLength(1);

    writing = false;

    await vi.waitFor(() =>
      expect(gone).toEqual([
        "it was still busy with a call 20 ms past its deadline",
      ]),
    );
    expect(await call).toBe("ended");
  });

  it("waits on for an app to get ready while the host writes out, until it is done", async () => {
    let writing = true;
    await listening({
      heartbeatMs: 5,
      readyWithinMs: 10,
      writeoutGraceMs: 10_000,
      isWritingOut: () => writing,
    });
    const app = await appOnSocket();
    app.say(welcomeHello);
    await app.hearing("welcome");

    await pause(60);
    expect(app.isClosed()).toBe(false);
    expect(saying("isn't ready yet while the host")).toHaveLength(1);

    writing = false;

    await vi.waitFor(() =>
      expect(gone).toEqual(["it didn't get ready in time"]),
    );
  });
});
