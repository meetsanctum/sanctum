import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { managerDataVolumeName } from "../core-container.js";
import { managedLabels } from "../docker-resources.js";
import type { SpaceDockerLike } from "../host/space.js";
import { prepareManagerHelper } from "../manager-helper.js";
import { stacked } from "../stack.js";

// A short privileged container, run from the manager's own image, for what only
// the kernel's loop devices allow. The manager stays unprivileged: it already
// holds the Docker socket, so this widens nothing. It has no network and sees
// only the manager's data volume.

export const helperDataAt = "/sanctum-data";
const name = stacked("sanctum-image-helper");
const role = "image-helper";

export type Helper = (
  script: string,
) => Promise<{ code: number; output: string }>;

export function createImageHelper(options: {
  docker: Pick<SpaceDockerLike, "createContainer" | "getContainer">;
  dataDir: string;
}): Helper {
  const { docker, dataDir } = options;
  const outputFolder = "images";
  const outputFile = ".helper-output";

  return async (script) => {
    const image = await prepareManagerHelper(docker, name, role, true);
    await mkdir(join(dataDir, outputFolder), { recursive: true });
    const { id } = await docker.createContainer({
      name,
      Image: image,
      Cmd: [
        "sh",
        "-c",
        `exec >${helperDataAt}/${outputFolder}/${outputFile} 2>&1\n${script}`,
      ],
      Labels: managedLabels(role),
      HostConfig: {
        Privileged: true,
        NetworkMode: "none",
        Binds: [`${managerDataVolumeName}:${helperDataAt}`],
      },
    });
    const container = docker.getContainer(id);
    try {
      await container.start();
      const { StatusCode } = await container.wait();
      const path = join(dataDir, outputFolder, outputFile);
      const output = await readFile(path, "utf8").catch(() => "");
      await unlink(path).catch(() => undefined);
      return { code: StatusCode, output };
    } finally {
      await container.remove({ force: true, v: true }).catch(() => undefined);
    }
  };
}
