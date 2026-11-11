import { assertManaged, managedLabels } from "../docker-resources.js";
import {
  errorMessage,
  inspectContainer,
  type DockerClientLike,
  type WaitableContainerLike,
} from "../docker.js";
import { stack, stacked } from "../stack.js";
import { managerContainerName } from "../update/manager-update.js";

// Restart and Shut down, from Settings → Status. The manager's container
// cannot reboot the machine itself, so, as with its updater, it starts a
// short-lived helper from its own image: privileged and in the host's process
// namespace, it enters init's namespaces and asks systemd. The helper is made
// before the answer, so a request that cannot work is refused, and started a
// moment after it, so the core can tell its clients first.

export type PowerAction = "restart" | "shutdown";

export class PowerConflictError extends Error {}

export const powerContainerName = stacked("sanctum-power");
export const powerRole = "power";
const systemctl: Record<PowerAction, string> = {
  restart: "reboot",
  shutdown: "poweroff",
};

export function createPower(options: {
  docker: Pick<DockerClientLike, "createContainer"> & {
    getContainer: (id: string) => WaitableContainerLike;
  };
  // Whether an update is running, which a restart would cut short.
  busy: () => Promise<boolean>;
  log: (message: string) => void;
  delayMs?: number;
}) {
  const { docker, log } = options;
  const delayMs = options.delayMs ?? 2_000;
  let asked: PowerAction | null = null;
  let reservation = 0;

  async function makeHelper(action: PowerAction) {
    const manager = await inspectContainer(docker, managerContainerName);
    if (!manager) {
      throw new Error(`No ${managerContainerName} container to start from`);
    }
    const stale = await inspectContainer(docker, powerContainerName);
    if (stale) {
      assertManaged(
        { labels: stale.Config.Labels, name: stale.Name },
        powerRole,
      );
      await docker.getContainer(stale.Id).remove({ force: true });
    }
    await docker.createContainer({
      name: powerContainerName,
      Image: manager.Image,
      Entrypoint: ["nsenter"],
      Cmd: [
        "-t",
        "1",
        "-m",
        "-u",
        "-i",
        "-n",
        "--",
        "systemctl",
        systemctl[action],
      ],
      Labels: managedLabels(powerRole),
      HostConfig: { Privileged: true, PidMode: "host", AutoRemove: true },
    });
  }

  return {
    // What was asked, until the machine goes down.
    asked: () => asked,

    async request(action: PowerAction) {
      // Its helper would reach the machine under Docker, and so every stack
      // on it.
      if (stack) {
        throw new PowerConflictError(
          "A development stack doesn't restart or shut down",
        );
      }
      if (asked) {
        throw new PowerConflictError(
          asked === "restart"
            ? "Sanctum is already restarting"
            : "Sanctum is already shutting down",
        );
      }
      // Reserve before checking the host: another request may arrive while
      // the update journal is being read.
      asked = action;
      const request = ++reservation;
      try {
        if (await options.busy()) {
          throw new PowerConflictError("An update is running");
        }
        await makeHelper(action);
      } catch (error) {
        asked = null;
        throw error;
      }
      log(
        action === "restart" ? "Restarting the host" : "Shutting the host down",
      );
      // systemctl can exit without the host going down even when Docker
      // started the helper. Allow another try when the clients stop waiting.
      const expiry = setTimeout(() => {
        if (reservation === request) asked = null;
      }, 60_000);
      expiry.unref();
      setTimeout(() => {
        const helper = docker.getContainer(powerContainerName);
        // Watched before it starts, since it removes itself once it ends.
        const ended = helper.wait({ condition: "removed" });
        const failed = (reason: string) => {
          clearTimeout(expiry);
          if (reservation === request) asked = null;
          log(`Could not ${action} the host: ${reason}`);
        };
        Promise.all([helper.start(), ended])
          .then(([, { StatusCode }]) => {
            if (StatusCode !== 0) failed(`systemctl ended with ${StatusCode}`);
          })
          .catch((error: unknown) => failed(errorMessage(error)));
      }, delayMs);
    },
  };
}

export type Power = ReturnType<typeof createPower>;
