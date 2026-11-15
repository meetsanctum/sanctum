import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import type { Log } from "../docker-resources.js";
import {
  errorMessage,
  roleLabel,
  type ContainerInfo,
  type EventsDockerLike,
} from "../docker.js";
import { isOurs } from "../stack.js";
import { appRole } from "./containers.js";

// Whether an app's container ran out of memory, beside what Docker's flag says.
//
// Docker sets OOMKilled once containerd reads, in the container's cgroup, that
// the kernel killed its process for its memory. Docker removes that cgroup as
// soon as the process has exited, and on a busy host it can be gone before
// containerd reads it: the flag stays false, and the app seems to have been
// killed by something else.
//
// Docker's events say what Docker itself did. It reports each signal it sends,
// for a stop, a kill or a stop that ran out of time, before it reports that
// the container died. Nothing inside an app's container can kill its process,
// the first of its own PID namespace, which takes no SIGKILL from inside it.
// So one seen to start that died of SIGKILL, with no signal from Docker and no
// stop of the manager's own, was killed by the kernel. One that started before
// the manager listened, as across the manager's own update, has Docker's flag
// alone.

// 128 + SIGKILL.
const killedExitCode = 137;
// Docker reports that it died just after its inspection says it stopped.
const diedWithinMs = 2_000;
const listenAgainMs = 5_000;

type DockerEvent = {
  Type?: string;
  Action?: string;
  Actor?: { ID?: string; Attributes?: Record<string, string> };
};

// One run of a container, from its start as Docker reported it.
type Run = {
  // Docker sent it a signal, or the manager is stopping it.
  signalled: boolean;
  died: boolean;
  onDied: Set<() => void>;
};

export function createAppExits(options: {
  docker: EventsDockerLike;
  log: Log;
  listenAgainMs?: number;
}) {
  const { docker, log } = options;
  const runs = new Map<string, Run>();
  // A stop can reach Docker before its queued start event reaches us.
  const pendingStops = new Set<string>();
  let isListening = false;
  // Said once while it can't hear them, not at each try.
  let isHearing = true;
  let events: Readable | undefined;
  let timer: NodeJS.Timeout | undefined;

  function forget(id: string) {
    const run = runs.get(id);
    runs.delete(id);
    pendingStops.delete(id);
    for (const done of run?.onDied ?? []) done();
  }

  function heard({ Type, Action, Actor }: DockerEvent) {
    const id = Actor?.ID;
    if (Type !== "container" || !id || !isOurs(Actor.Attributes)) return;
    const run = runs.get(id);
    if (Action === "start") {
      const isStopping = pendingStops.has(id);
      forget(id);
      runs.set(id, {
        signalled: isStopping,
        died: false,
        onDied: new Set(),
      });
    } else if (Action === "kill") {
      if (run) run.signalled = true;
    } else if (Action === "die") {
      pendingStops.delete(id);
      if (!run) return;
      run.died = true;
      for (const done of run.onDied) done();
    } else if (Action === "destroy") {
      forget(id);
    }
  }

  async function listen() {
    timer = undefined;
    // From the second it asks, so nothing between asking and hearing is lost.
    const since = String(Math.floor(Date.now() / 1000));
    try {
      const stream = await docker.getEvents({
        since,
        filters: {
          type: ["container"],
          event: ["start", "kill", "die", "destroy"],
          label: [`${roleLabel}=${appRole}`],
        },
      });
      if (!isListening) {
        stream.destroy();
        return;
      }
      events = stream;
      if (!isHearing) log("Hearing Docker's events again");
      isHearing = true;
      for await (const line of createInterface({ input: stream })) {
        let event: DockerEvent;
        try {
          event = JSON.parse(line) as DockerEvent;
        } catch {
          continue;
        }
        heard(event);
      }
      if (isListening) log("Docker's events ended: listening again");
    } catch (error) {
      if (isListening && isHearing) {
        log(`Not hearing Docker's events: ${errorMessage(error)}`);
      }
      isHearing = false;
    }
    // What came while it wasn't listening is unknown, so each run it knew
    // goes with it.
    events = undefined;
    for (const id of [...runs.keys()]) forget(id);
    pendingStops.clear();
    if (isListening) {
      timer = setTimeout(
        () => void listen(),
        options.listenAgainMs ?? listenAgainMs,
      );
      timer.unref();
    }
  }

  return {
    start() {
      if (isListening) return;
      isListening = true;
      void listen();
    },

    stop() {
      isListening = false;
      clearTimeout(timer);
      timer = undefined;
      events?.destroy();
      for (const id of [...runs.keys()]) forget(id);
      pendingStops.clear();
    },

    // Before the manager stops or removes a running one, whose SIGKILL is then
    // its own.
    stopping(id: string) {
      pendingStops.add(id);
      const run = runs.get(id);
      if (run) run.signalled = true;
    },

    async outOfMemory(container: ContainerInfo) {
      const { Id: id, State: state } = container;
      if (state.OOMKilled) return true;
      if (state.Running || state.ExitCode !== killedExitCode) return false;
      const run = runs.get(id);
      if (!run || run.signalled) return false;
      if (!run.died) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timeout);
            run.onDied.delete(done);
            resolve();
          };
          const timeout = setTimeout(done, diedWithinMs);
          run.onDied.add(done);
        });
      }
      return run.died && !run.signalled;
    },
  };
}

export type AppExits = ReturnType<typeof createAppExits>;
