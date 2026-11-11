import {
  imageServiceLabel,
  imageVersionLabel,
  inspectImage,
  pullImage,
  type DockerClientLike,
  type ImageInfo,
} from "../docker.js";
import type { Service } from "../release.js";
import type { UpdateStep } from "./journal.js";
import { isOurs, stack, stackLabel } from "../stack.js";

export function imageVersion(image: ImageInfo | null) {
  return (
    image?.Config?.Labels?.[imageVersionLabel] ??
    image?.Config?.Env?.find((entry) =>
      entry.startsWith("SANCTUM_VERSION="),
    )?.split("=")[1]
  );
}

// Pulls a service's new image and records what it resolved to. Refuses an
// image that is not that service, so a mixed-up tag never replaces the core.
export async function pullServiceImage(
  docker: DockerClientLike,
  service: Service,
  step: UpdateStep,
) {
  await pullImage(docker, step.image);
  const image = await inspectImage(docker, step.image);
  const imageService = image?.Config?.Labels?.[imageServiceLabel];
  if (!image || imageService !== service) {
    throw new Error(`${step.image} is not a sanctum-${service} image`);
  }
  step.imageId = image.Id;
  step.version = imageVersion(image) ?? "unknown";
}

// Removes a service's images that no container uses, keeping the ones given
// (the version just replaced, for a manual rollback). Dev builds would
// otherwise fill a Pi's SD card.
export async function pruneImages(
  docker: DockerClientLike,
  service: Service,
  keep: Array<string | undefined>,
) {
  const images = await docker.listImages({
    filters: {
      label: [
        `${imageServiceLabel}=${service}`,
        ...(stack ? [`${stackLabel}=${stack}`] : []),
      ],
    },
  });
  const used = new Set(
    (await docker.listContainers({ all: true })).map(
      (container) => container.ImageID,
    ),
  );
  for (const image of images) {
    if (!used.has(image.Id) && !keep.includes(image.Id)) {
      const info = await inspectImage(docker, image.Id);
      if (!info || !isOurs(info.Config?.Labels)) continue;
      await docker
        .getImage(image.Id)
        .remove({ force: true })
        .catch(() => undefined);
    }
  }
}
