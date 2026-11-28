import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

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
afterEach(() => {
  vi.useRealTimers();
});

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
      "apps: sanctum.example hasn't answered its heartbeat while the host writes out to its disks; it gets up to 10 s more",
    ]);

    app.say({ type: "pong", beat: 1 });
    await vi.waitFor(() =>
      expect(logs).toContain("apps: sanctum.example answers again"),
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
    await vi.waitFor(() =>
      expect(
        saying("hasn't answered its heartbeat while the host"),
      ).toHaveLength(1),
    );
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

  it("counts previously spared beats toward the normal cutoff when turned off", async () => {
    let off = false;
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => (markReady = resolve));
    await listening({
      heartbeatMs: 5,
      isWritingOut: () => true,
      isOff: () => off,
      onReady: markReady,
    });
    const app = await appOnSocket();
    app.say(welcomeHello);
    await app.hearing("welcome");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    app.say({ type: "ready" });
    await ready;

    vi.advanceTimersByTime(20);
    expect(saying("hasn't answered its heartbeat while the host")).toHaveLength(
      1,
    );
    expect(gone).toEqual([]);

    off = true;
    vi.advanceTimersByTime(5);
    expect(gone).toEqual(["it missed 3 heartbeats"]);
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
        "it was still busy with a call 20 ms past its deadline, and more while the host wrote out to its disks",
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

  async function preparing(isWritingOut: () => boolean) {
    await listening({
      heartbeatMs: 5,
      readyWithinMs: 10,
      writeoutGraceMs: 20,
      isWritingOut,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const app = await appOnSocket();
    const welcome = once(app.socket, "data");
    app.say(welcomeHello);
    await welcome;
    expect(app.heard[0]?.type).toBe("welcome");
    return app;
  }

  it("ends a connection that still isn't ready at the grace limit during writeout", async () => {
    await preparing(() => true);

    vi.advanceTimersByTime(29);
    expect(link.isConnected()).toBe(true);
    expect(gone).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(gone).toEqual(["it didn't get ready in time"]);
  });

  it("accepts ready between the first and second checks after writeout ends", async () => {
    let writing = true;
    const app = await preparing(() => writing);
    vi.advanceTimersByTime(10);

    writing = false;
    vi.advanceTimersByTime(5);
    expect(link.isConnected()).toBe(true);

    const ping = once(app.socket, "data");
    app.say({ type: "ready" });
    await ping;
    expect(app.heard[1]?.type).toBe("ping");

    vi.advanceTimersByTime(15);
    expect(link.isReady()).toBe(true);
    expect(gone).toEqual([]);
  });
});
