import { describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";
import { createVersionList } from "../src/update/versions.js";
import { createHost } from "./host.js";

const digest = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;

// A registry like the one on a dev host: each build's core and manager
// images, by tag, the way `pnpm host:push` leaves them.
function fakeRegistry(architecture = "arm64") {
  const routes = new Map<string, unknown>();
  const asked: string[] = [];
  let next = 1;

  function image(
    repository: string,
    tag: string,
    options: { created?: string; service?: string; index?: boolean },
  ) {
    const config = digest(next++);
    routes.set(`${repository}/blobs/${config}`, {
      os: "linux",
      architecture,
      created: options.created,
      config: { Labels: { "sanctum.service": options.service } },
    });
    const single = { config: { digest: config } };
    if (options.index) {
      const arm = digest(next++);
      routes.set(`${repository}/manifests/${arm}`, single);
      routes.set(`${repository}/manifests/${tag}`, {
        manifests: [
          {
            digest: digest(next++),
            platform: { os: "linux", architecture: "amd64" },
          },
          { digest: arm, platform: { os: "linux", architecture: "arm64" } },
        ],
      });
    } else {
      routes.set(`${repository}/manifests/${tag}`, single);
    }
  }

  const tags = {
    "sanctum-core": [] as string[],
    "sanctum-manager": [] as string[],
  };
  return {
    asked,
    build(
      tag: string,
      created: string,
      options: { index?: boolean; only?: "core" } = {},
    ) {
      image("sanctum-core", tag, { created, service: "core", ...options });
      tags["sanctum-core"].push(tag);
      if (options.only !== "core") {
        image("sanctum-manager", tag, { created, service: "manager" });
        tags["sanctum-manager"].push(tag);
      }
    },
    image,
    tag(repository: keyof typeof tags, tag: string) {
      tags[repository].push(tag);
    },
    fetch: async (url: string) => {
      const path = new URL(url).pathname.replace(/^\/v2\//, "");
      asked.push(path);
      const [repository, kind] = path.split("/");
      const body =
        kind === "tags"
          ? { name: repository, tags: tags[repository as keyof typeof tags] }
          : routes.get(path);
      return body === undefined
        ? new Response(JSON.stringify({ errors: [] }), { status: 404 })
        : new Response(JSON.stringify(body));
    },
  };
}

describe("the versions a host can update to", () => {
  it("lists a dev host's builds, newest first", async () => {
    const registry = fakeRegistry();
    registry.build("dev-1a2b3c4", "2026-10-27T09:00:00.5Z");
    registry.build("dev-5e6f7a8", "2026-10-28T09:00:00Z", { index: true });
    registry.build("dev-9a8b7c6-20261028101500", "2026-10-28T10:15:00Z");
    const versions = createVersionList({
      config: { channel: "dev", devRegistry: "localhost:5000" },
      fetch: registry.fetch,
      arch: "arm64",
    });

    expect(await versions.list()).toEqual({
      channel: "dev",
      versions: [
        {
          version: "dev-9a8b7c6-20261028101500",
          builtAt: "2026-10-28T10:15:00Z",
        },
        { version: "dev-5e6f7a8", builtAt: "2026-10-28T09:00:00Z" },
        { version: "dev-1a2b3c4", builtAt: "2026-10-27T09:00:00.5Z" },
      ],
    });
  });

  it("leaves out what the host could not update to", async () => {
    const registry = fakeRegistry("riscv64");
    registry.build("dev-1a2b3c4", "2026-10-27T09:00:00Z");
    // Pushed halfway: only the core made it.
    registry.build("dev-5e6f7a8", "2026-10-28T09:00:00Z", { only: "core" });
    // Not a dev build, and a build for another platform only.
    registry.tag("sanctum-core", "latest");
    registry.tag("sanctum-manager", "latest");
    registry.build("dev-0f0f0f0", "2026-10-28T11:00:00Z", { index: true });
    const versions = createVersionList({
      config: { channel: "dev", devRegistry: "localhost:5000" },
      fetch: registry.fetch,
      arch: "riscv64",
    });

    expect((await versions.list()).versions).toEqual([
      { version: "dev-1a2b3c4", builtAt: "2026-10-27T09:00:00Z" },
    ]);
    expect(registry.asked).not.toContain("sanctum-core/manifests/latest");
  });

  it("reads each image's config once", async () => {
    const registry = fakeRegistry();
    registry.build("dev-1a2b3c4", "2026-10-27T09:00:00Z");
    const versions = createVersionList({
      config: { channel: "dev", devRegistry: "localhost:5000" },
      fetch: registry.fetch,
      arch: "arm64",
    });

    await versions.list();
    await versions.list();

    expect(
      registry.asked.filter((path) => path.includes("/blobs/")),
    ).toHaveLength(2);
  });

  it("requires both images to match the host, including single manifests", async () => {
    const registry = fakeRegistry("amd64");
    registry.build("dev-core-wrong", "2026-10-27T09:00:00Z");
    const versions = createVersionList({
      config: { channel: "dev", devRegistry: "localhost:5000" },
      fetch: registry.fetch,
      arch: "arm64",
    });
    expect((await versions.list()).versions).toEqual([]);

    const armRegistry = fakeRegistry();
    armRegistry.build("dev-manager-wrong", "2026-10-28T09:00:00Z");
    armRegistry.image("sanctum-manager", "dev-manager-wrong", {
      service: "core",
    });
    const armVersions = createVersionList({
      config: { channel: "dev", devRegistry: "localhost:5000" },
      fetch: armRegistry.fetch,
      arch: "arm64",
    });
    expect((await armVersions.list()).versions).toEqual([]);
  });

  it("finds the newest build beyond the first page of either repository", async () => {
    const registry = fakeRegistry();
    registry.build("dev-aaa", "2026-10-27T09:00:00Z");
    registry.build("dev-zzz", "2026-10-28T09:00:00Z");
    const pages: string[] = [];
    const versions = createVersionList({
      config: { channel: "dev", devRegistry: "localhost:5000" },
      arch: "arm64",
      fetch: async (url) => {
        const parsed = new URL(url);
        if (!parsed.pathname.endsWith("/tags/list")) return registry.fetch(url);
        pages.push(parsed.pathname + parsed.search);
        return parsed.searchParams.has("last")
          ? Response.json({ tags: ["dev-zzz"] })
          : Response.json(
              { tags: ["dev-aaa"] },
              {
                headers: {
                  link: `<${parsed.pathname}?n=1&last=dev-aaa>; rel="next"`,
                },
              },
            );
      },
    });

    expect(
      (await versions.list()).versions.map(({ version }) => version),
    ).toEqual(["dev-zzz", "dev-aaa"]);
    expect(pages).toHaveLength(4);
  });

  it("refuses pagination outside the repository or back to a visited page", async () => {
    for (const next of [
      "http://elsewhere.test/v2/sanctum-core/tags/list?n=1000",
      "/v2/other/tags/list?n=1000",
      "/v2/sanctum-core/tags/list?n=1000",
    ]) {
      const versions = createVersionList({
        config: { channel: "dev", devRegistry: "localhost:5000" },
        fetch: async (url) =>
          Response.json(
            { tags: [] },
            {
              headers: new URL(url).pathname.includes("sanctum-core")
                ? { link: `<${next}>; rel="next"` }
                : {},
            },
          ),
      });
      await expect(versions.list()).rejects.toThrow(/tag page/);
    }
  });

  it("offers a stable or edge host its channel", async () => {
    for (const channel of ["stable", "edge"] as const) {
      const versions = createVersionList({
        config: { channel, devRegistry: "localhost:5000" },
        fetch: async () => {
          throw new Error("A household host has no registry to ask");
        },
      });
      expect(await versions.list()).toEqual({
        channel,
        versions: [{ version: channel }],
      });
    }
  });

  it("answers through the socket, and says when the registry is away", async () => {
    const host = await createHost();
    const registry = fakeRegistry();
    registry.build("dev-1a2b3c4", "2026-10-27T09:00:00Z");
    let isUp = true;
    const server = createServer(
      { version: "dev-1" },
      {
        host: {
          docker: host.docker,
          updates: host.updates,
          versions: createVersionList({
            config: { channel: "dev", devRegistry: "localhost:5000" },
            arch: "arm64",
            fetch: async (url) => {
              if (!isUp) throw new TypeError("fetch failed");
              return registry.fetch(url);
            },
          }),
        },
      },
    );

    const listed = await server.inject({ url: "/api/update/versions" });
    isUp = false;
    const away = await server.inject({ url: "/api/update/versions" });

    expect(listed.json()).toEqual({
      channel: "dev",
      versions: [{ version: "dev-1a2b3c4", builtAt: "2026-10-27T09:00:00Z" }],
    });
    expect(away.statusCode).toBe(502);
    expect(away.json()).toEqual({
      error: "The host's registry did not answer",
    });
  });
});
