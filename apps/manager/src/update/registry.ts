import { z } from "zod";

import type { Fetch } from "../socket.js";

// The dev channel's registry on the host, over its HTTP API: the builds pushed
// to it, their manifests, and removing them, which the registry allows only
// with REGISTRY_STORAGE_DELETE_ENABLED (Free up space, host/space.ts).

export class RegistryError extends Error {}

export const manifestTypes = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const tagList = z.object({ tags: z.array(z.string()).nullable() });
const descriptor = z.object({
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  size: z.number().int().nonnegative().optional(),
  platform: z.object({ architecture: z.string(), os: z.string() }).optional(),
});
// An image's manifest, with its config and layers, or an index of them.
export const manifest = z.union([
  z.object({ config: descriptor, layers: z.array(descriptor).optional() }),
  z.object({ manifests: z.array(descriptor) }),
]);
export type Manifest = z.infer<typeof manifest>;

export function createRegistry(options: { address: string; fetch?: Fetch }) {
  const fetcher = options.fetch ?? fetch;

  async function request(path: string, init: RequestInit = {}) {
    const url = `http://${options.address}/v2/${path}`;
    try {
      return await fetcher(url, {
        ...init,
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new RegistryError("The host's registry did not answer");
    }
  }

  async function json<T extends z.ZodType>(
    path: string,
    schema: T,
    accept?: string,
  ): Promise<{ data: z.output<T>; headers: Headers }> {
    const response = await request(path, {
      headers: accept ? { accept } : undefined,
    });
    if (!response.ok) {
      throw new RegistryError(
        `The host's registry answered ${response.status} for ${path}`,
      );
    }
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new RegistryError(`The host's registry sent an unknown ${path}`);
    }
    return { data: parsed.data, headers: response.headers };
  }

  return {
    json,

    // Every tag of a repository, through the registry's pages.
    async tags(repository: string) {
      const endpoint = new URL(
        `http://${options.address}/v2/${repository}/tags/list`,
      );
      let path = `${repository}/tags/list?n=1000`;
      const visited = new Set<string>();
      const found = new Set<string>();
      while (true) {
        if (visited.has(path)) {
          throw new RegistryError("The host's registry repeated a tag page");
        }
        visited.add(path);
        const { data: list, headers } = await json(path, tagList);
        for (const tag of list.tags ?? []) found.add(tag);
        const link = headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/);
        if (!link) return [...found];
        const next = new URL(link[1]!, endpoint);
        if (
          next.origin !== endpoint.origin ||
          next.pathname !== endpoint.pathname
        ) {
          throw new RegistryError(
            "The host's registry sent an unknown tag page",
          );
        }
        path = next.pathname.slice("/v2/".length) + next.search;
      }
    },

    // A tag's manifest and its digest.
    async manifest(repository: string, reference: string) {
      const { data, headers } = await json(
        `${repository}/manifests/${reference}`,
        manifest,
        manifestTypes,
      );
      const digest = headers.get("docker-content-digest");
      return { manifest: data, digest };
    },

    // Removes a manifest by its digest: false when the registry doesn't
    // allow it, true once it is gone.
    async remove(repository: string, digest: string) {
      const response = await request(`${repository}/manifests/${digest}`, {
        method: "DELETE",
      });
      if (response.status === 405) return false;
      if (response.ok || response.status === 404) return true;
      throw new RegistryError(
        `The host's registry answered ${response.status} for removing ${digest}`,
      );
    },
  };
}

export type Registry = ReturnType<typeof createRegistry>;
