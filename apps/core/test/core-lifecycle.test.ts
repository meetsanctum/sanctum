import { describe, expect, it } from "vitest";

import {
  createCoreLifecycle,
  type CoreStep,
  type CoreSteps,
} from "../src/lifecycle.js";

// The core's phases, its readiness and the steps each phase runs
// (lifecycle.ts), with steps that only say what they did.

function lifecycleOf() {
  const logs: string[] = [];
  const done: string[] = [];
  const lifecycle = createCoreLifecycle({ log: (line) => logs.push(line) });
  const step = (label: string): CoreStep => [
    label,
    () => void done.push(label),
  ];
  const steps = (table: Partial<CoreSteps>): CoreSteps => ({
    starting: [],
    stopNewWork: [],
    stopping: [],
    ...table,
  });
  return { lifecycle, logs, done, step, steps };
}

const failing =
  (error: string): CoreStep[1] =>
  () => {
    throw new Error(error);
  };

describe("the core's lifecycle", () => {
  it("runs starting's steps in order, then runs", async () => {
    const { lifecycle, logs, done, step, steps } = lifecycleOf();
    expect(lifecycle.phase()).toBe("starting");

    await lifecycle.start(
      steps({ starting: [step("open core.db"), step("listen")] }),
    );

    expect(done).toEqual(["open core.db", "listen"]);
    expect(lifecycle.phase()).toBe("running");
    expect(logs).toEqual([
      "core: starting",
      "core: starting: open core.db",
      "core: starting: listen",
      "core: running",
    ]);
  });

  it("starts once", async () => {
    const { lifecycle, steps } = lifecycleOf();
    await lifecycle.start(steps({}));

    await expect(lifecycle.start(steps({}))).rejects.toThrow(
      "the core starts once",
    );
  });

  it("stops with exit code 1 when a step of starting fails, and runs no later one", async () => {
    const { lifecycle, done, step, steps } = lifecycleOf();

    await lifecycle.start(
      steps({
        starting: [
          step("open core.db"),
          ["build the modules", failing("no space")],
          step("listen"),
        ],
        stopping: [step("close core.db")],
      }),
    );

    expect(await lifecycle.stopped).toEqual({
      code: 1,
      failedSteps: ["build the modules"],
    });
    expect(done).toEqual(["open core.db", "close core.db"]);
    expect(lifecycle.phase()).toBe("stopped");
  });

  it("tries every step of stopping, and exits with 1 if one failed", async () => {
    const { lifecycle, logs, done, step, steps } = lifecycleOf();
    await lifecycle.start(
      steps({
        stopping: [
          step("close the server"),
          ["stop the app host", failing("a link hung")],
          step("close core.db"),
        ],
      }),
    );

    const exit = await lifecycle.stop("signal");

    expect(exit).toEqual({ code: 1, failedSteps: ["stop the app host"] });
    expect(done).toEqual(["close the server", "close core.db"]);
    expect(logs.slice(-6)).toEqual([
      "core: stopping (signal)",
      "core: stopping: close the server",
      "core: stopping: stop the app host",
      "core: stop the app host failed (a link hung)",
      "core: stopping: close core.db",
      "core: stopped (1)",
    ]);
  });

  it("stops once: a second signal waits for the first stop", async () => {
    const { lifecycle, done, step, steps } = lifecycleOf();
    await lifecycle.start(steps({ stopping: [step("close core.db")] }));

    const first = lifecycle.stop("signal");
    const second = lifecycle.stop("signal");

    expect(second).toBe(first);
    expect(await second).toEqual({ code: 0, failedSteps: [] });
    expect(done).toEqual(["close core.db"]);
  });

  it("stops new work before it waits for anything", async () => {
    const { lifecycle, done, step, steps } = lifecycleOf();
    await lifecycle.start(
      steps({
        stopNewWork: [["workflows", () => void done.push("no new runs")]],
        stopping: [step("close the server")],
      }),
    );

    const stopping = lifecycle.stop("signal");

    expect(lifecycle.phase()).toBe("stopping");
    expect(done).toEqual(["no new runs"]);
    await stopping;
    expect(done).toEqual(["no new runs", "close the server"]);
  });

  it("cancels a step of starting under way, waits for it and runs no later one", async () => {
    const { lifecycle, done, step, steps } = lifecycleOf();
    let waiting!: () => void;
    const waits = new Promise<void>((resolve) => (waiting = resolve));
    const starting = lifecycle.start(
      steps({
        starting: [
          [
            "wait for the certificate",
            (cancelled) =>
              new Promise<void>((resolve) => {
                waiting();
                cancelled.addEventListener("abort", () => {
                  done.push("gave up waiting");
                  resolve();
                });
              }),
          ],
          step("listen"),
        ],
        stopping: [step("close core.db")],
      }),
    );
    await waits;

    const exit = await lifecycle.stop("signal");
    await starting;

    expect(exit).toEqual({ code: 0, failedSteps: [] });
    expect(done).toEqual(["gave up waiting", "close core.db"]);
    expect(lifecycle.phase()).toBe("stopped");
  });

  it("doesn't count a step that fails because stopping began", async () => {
    const { lifecycle, steps } = lifecycleOf();
    let waiting!: () => void;
    const waits = new Promise<void>((resolve) => (waiting = resolve));
    const starting = lifecycle.start(
      steps({
        starting: [
          [
            "wait for the certificate",
            (cancelled) =>
              new Promise<void>((_resolve, reject) => {
                waiting();
                cancelled.addEventListener("abort", () =>
                  reject(new Error("the manager client was closed")),
                );
              }),
          ],
        ],
      }),
    );
    await waits;

    expect(await lifecycle.stop("signal")).toEqual({
      code: 0,
      failedSteps: [],
    });
    await starting;
  });

  it("stops with exit code 1 when its background work fails", async () => {
    const { lifecycle, done, step, steps } = lifecycleOf();
    await lifecycle.start(
      steps({
        starting: [
          [
            "install the apps",
            () =>
              lifecycle.ownBackgroundTask("install the apps", async () => {
                throw new Error("a package can't be read");
              }),
          ],
        ],
        stopping: [step("close core.db")],
      }),
    );

    expect(await lifecycle.stopped).toEqual({
      code: 1,
      failedSteps: ["install the apps"],
    });
    expect(done).toEqual(["close core.db"]);
  });

  it("exits with 1 when background work fails while a signal stops the core", async () => {
    const { lifecycle, steps } = lifecycleOf();
    let fail!: () => void;
    await lifecycle.start(
      steps({
        starting: [
          [
            "install the apps",
            () =>
              lifecycle.ownBackgroundTask(
                "install the apps",
                () =>
                  new Promise<void>((_resolve, reject) => {
                    fail = () => reject(new Error("a package can't be read"));
                  }),
              ),
          ],
        ],
        stopping: [
          [
            "stop the app host",
            async () => {
              fail();
              await new Promise((resolve) => setTimeout(resolve, 0));
            },
          ],
        ],
      }),
    );

    expect(await lifecycle.stop("signal")).toEqual({
      code: 1,
      failedSteps: ["install the apps"],
    });
  });

  it("cancels background work as stopping begins", async () => {
    const { lifecycle, steps } = lifecycleOf();
    let signal!: AbortSignal;
    await lifecycle.start(
      steps({
        starting: [
          [
            "install the apps",
            () =>
              lifecycle.ownBackgroundTask("install the apps", async (each) => {
                signal = each;
              }),
          ],
        ],
      }),
    );
    expect(signal.aborted).toBe(false);

    await lifecycle.stop("signal");

    expect(signal.aborted).toBe(true);
  });

  it("answers only its health check from a trial's start until the update commits", async () => {
    const { lifecycle, logs, steps } = lifecycleOf();
    expect(lifecycle.readiness()).toBe("everyone");

    await lifecycle.start(
      steps({
        starting: [
          ["watch for a pending update", () => lifecycle.beginTrial()],
        ],
      }),
    );
    expect(lifecycle.readiness()).toBe("healthOnly");
    expect(lifecycle.phase()).toBe("running");

    lifecycle.commit();
    lifecycle.commit();

    expect(lifecycle.readiness()).toBe("everyone");
    expect(logs.filter((line) => line.includes("committed"))).toEqual([
      "core: the update committed",
    ]);
    expect(() => lifecycle.beginTrial()).toThrow(
      "a core that's running can't begin a trial",
    );
  });
});
