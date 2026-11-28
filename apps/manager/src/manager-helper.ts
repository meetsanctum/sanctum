import { assertManaged } from "./docker-resources.js";
import { inspectContainer, type DockerClientLike } from "./docker.js";
import { managerContainerName } from "./update/manager-update.js";

export async function prepareManagerHelper(
  docker: Pick<DockerClientLike, "getContainer">,
  name: string,
  role: string,
  removeVolumes = false,
) {
  const manager = await inspectContainer(docker, managerContainerName);
  if (!manager) throw new Error("The manager can't find its own image");
  const stale = await inspectContainer(docker, name);
  if (stale) {
    assertManaged({ labels: stale.Config.Labels, name: stale.Name }, role);
    await docker.getContainer(stale.Id).remove({
      force: true,
      ...(removeVolumes ? { v: true } : {}),
    });
  }
  return manager.Image;
}
