import { describe, expect, it } from "vitest";

import type { ContainerInfo, ImageInfo } from "../src/docker.js";
import { cloneContainerOptions } from "../src/update/clone.js";

const image: ImageInfo = {
  Id: "sha256:old",
  Config: {
    Env: ["PATH=/usr/bin", "SANCTUM_VERSION=dev-1", "MANAGER_HOST=127.0.0.1"],
    Labels: { "org.opencontainers.image.version": "dev-1" },
    Cmd: ["node", "dist/index.js"],
    Entrypoint: ["docker-entrypoint.sh"],
    WorkingDir: "/app",
    ExposedPorts: { "4200/tcp": {} },
  },
};

function container(overrides: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    Id: "0123456789abcdef",
    Name: "/sanctum-manager",
    Image: "sha256:old",
    State: { Running: true },
    Config: {
      Hostname: "raspberrypi",
      Image: "localhost:5000/sanctum-manager:dev-1",
      Env: [...(image.Config?.Env ?? []), "SANCTUM_CHANNEL=dev"],
      Labels: {
        "org.opencontainers.image.version": "dev-1",
        "com.docker.compose.project": "sanctum",
      },
      Cmd: ["node", "dist/index.js"],
      Entrypoint: ["docker-entrypoint.sh"],
      WorkingDir: "/app",
      ExposedPorts: { "4200/tcp": {} },
      Healthcheck: { Test: ["CMD", "wget", "-qO-", "http://127.0.0.1:4200"] },
    },
    HostConfig: {
      NetworkMode: "host",
      Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
      RestartPolicy: { Name: "unless-stopped" },
    },
    ...overrides,
  };
}

describe("cloneContainerOptions", () => {
  it("keeps what the container's creator set and drops the image's values", () => {
    const options = cloneContainerOptions(
      container(),
      image,
      "localhost:5000/sanctum-manager:dev-2",
      "sanctum-manager",
    );

    expect(options).toEqual({
      name: "sanctum-manager",
      Image: "localhost:5000/sanctum-manager:dev-2",
      Env: ["SANCTUM_CHANNEL=dev"],
      Labels: { "com.docker.compose.project": "sanctum" },
      ExposedPorts: {},
      Volumes: {},
      Healthcheck: { Test: ["CMD", "wget", "-qO-", "http://127.0.0.1:4200"] },
      HostConfig: container().HostConfig,
    });
  });

  it("keeps a container's networks and aliases, without its id", () => {
    const options = cloneContainerOptions(
      container({
        HostConfig: { NetworkMode: "sanctum" },
        NetworkSettings: {
          Networks: { sanctum: { Aliases: ["0123456789ab", "manager"] } },
        },
      }),
      image,
      "next",
      "sanctum-manager",
    );

    expect(options.NetworkingConfig).toEqual({
      EndpointsConfig: { sanctum: { Aliases: ["manager"] } },
    });
  });
});
