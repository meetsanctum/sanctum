import {
  errorMessage,
  inspectContainer,
  type DockerClientLike,
} from "../docker.js";
import type { Fetch } from "../socket.js";

export type HealthBody = {
  status?: string;
  version?: string;
  updatePending?: boolean;
};

export type HealthTiming = {
  // How long a new version gets to answer healthy.
  timeoutMs: number;
  // How long it must keep answering healthy before it counts.
  settleMs: number;
  intervalMs: number;
};

export const defaultHealthTiming: HealthTiming = {
  timeoutMs: 90_000,
  settleMs: 5_000,
  intervalMs: 1_000,
};

export class HealthCheckError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits until a container answers healthy for a while. Fails early when the
// container stops or restarts, since a crashing version never recovers.
export async function waitForHealth(options: {
  accept: (body: HealthBody) => boolean;
  containerName: string;
  docker: DockerClientLike;
  fetch?: Fetch;
  timing: HealthTiming;
  url: string;
}) {
  const { docker, timing } = options;
  const fetcher = options.fetch ?? fetch;
  const deadline = Date.now() + timing.timeoutMs;
  let healthySince: number | null = null;
  let restartCount: number | null = null;
  let last = "no answer";

  for (;;) {
    const container = await inspectContainer(docker, options.containerName);
    if (!container) {
      throw new HealthCheckError(`${options.containerName} disappeared`);
    }
    restartCount ??= container.RestartCount ?? 0;
    if (!container.State.Running || container.State.Restarting) {
      throw new HealthCheckError(`${options.containerName} stopped`);
    }
    if ((container.RestartCount ?? 0) > restartCount) {
      throw new HealthCheckError(`${options.containerName} restarted`);
    }

    try {
      const response = await fetcher(options.url, {
        signal: AbortSignal.timeout(3_000),
      });
      const body = (await response.json()) as HealthBody;
      last = `${response.status} ${JSON.stringify(body)}`;
      if (response.ok && options.accept(body)) {
        healthySince ??= Date.now();
        if (Date.now() - healthySince >= timing.settleMs) {
          return;
        }
      } else {
        healthySince = null;
      }
    } catch (error) {
      healthySince = null;
      last = errorMessage(error);
    }

    if (Date.now() >= deadline) {
      throw new HealthCheckError(
        `${options.containerName} was not healthy within ${Math.round(timing.timeoutMs / 1000)}s (last: ${last})`,
      );
    }
    await sleep(timing.intervalMs);
  }
}
