import { z } from "zod";

import {
  assertManaged,
  ensureNetwork,
  managedLabels,
  type Log,
} from "../docker-resources.js";
import {
  inspectContainer,
  isNotFound,
  type ContainerInfo,
  type DockerClientLike,
  type WaitableContainerLike,
} from "../docker.js";
import { stacked } from "../stack.js";
import { AppRefusal } from "./refusal.js";

// An app that reaches the devices it found gets a network of its own: a bridge
// network for it alone, owned by its holder, a container from the manager's
// own image that only sleeps, whose network the app's container shares, as a
// Kubernetes pod shares its pause container's. Before the app's container
// starts, a short helper joins the holder's network, never the host's, with
// NET_ADMIN alone, loads Sanctum's rules there as one nftables table and reads
// them back. The rules let the app open connections only to its found
// devices' addresses, on its ports, every packet checked in either direction
// rather than passed for a connection passed before, so taking an address away
// cuts its connection. Nothing else goes: not DNS, Docker's resolver at
// 127.0.0.11 included whatever port it maps, nor the host, the core and the
// manager, other containers, the internet, IPv6 or anything arriving that
// isn't a reply. The rules live in the app's own network, so neither a reboot
// nor someone clearing the host's firewall touches them; a cleared firewall
// takes Docker's forwarding with it, which cuts the app off until its network
// is made again. Holder and app are one unit: neither restarts by itself, they
// stop and go together, and an app whose holder is gone is stopped.

export const holderRole = "app-holder";
const rulesRole = "app-rules";
const appLabel = "sanctum.app";
const table = "inet sanctum";

// The most addresses and ports one policy holds.
export const maxLanAddresses = 256;
export const maxLanPorts = 16;

const ipv4 = z.ipv4();

/** What an app's network may reach, as the core names it (core's app-host/lan.ts). */
export const lanPolicy = z.object({
  core: z.string().min(1).max(64),
  count: z.number().int().min(1),
  addresses: z.array(ipv4).max(maxLanAddresses),
  ports: z.array(z.number().int().min(1).max(65_535)).max(maxLanPorts),
});
export type LanPolicy = z.infer<typeof lanPolicy>;

/** A change of it, for the holder the core last heard of. */
export const lanChange = lanPolicy.extend({
  manager: z.string().min(1).max(64),
  holder: z.string().min(1).max(128),
});

/** Which policy a holder's rules hold, as the manager answers it. */
export type LanVersion = {
  core: string;
  count: number;
  manager: string;
  holder: string;
};

export function lanNetworkName(app: string) {
  return stacked(`sanctum-app-${app}-lan`);
}

export function holderName(app: string) {
  return stacked(`sanctum-app-${app}-holder`);
}

function nextHolderName(app: string) {
  return `${holderName(app)}-next`;
}

const marker = (policy: { core: string; count: number }) =>
  `sanctum ${policy.core} ${policy.count}`;

/**
 * The rules, replacing what the table held in one step: adding it first so
 * that deleting it never fails, then making it again.
 */
export function rulesFor(policy: LanPolicy) {
  const addresses = [...new Set(policy.addresses)].sort();
  const ports = [...new Set(policy.ports)].sort((a, b) => a - b);
  const elements = (values: readonly (string | number)[]) =>
    values.length > 0 ? ` elements = { ${values.join(", ")} };` : "";
  return [
    `table ${table}`,
    `delete table ${table}`,
    `table ${table} {`,
    `  comment "${marker(policy)}"`,
    `  set reach { type ipv4_addr;${elements(addresses)} }`,
    `  set reachports { type inet_service;${elements(ports)} }`,
    "  chain output {",
    "    type filter hook output priority 0; policy drop;",
    "    ip daddr @reach tcp dport @reachports accept",
    "  }",
    "  chain input {",
    "    type filter hook input priority 0; policy drop;",
    "    ip saddr @reach tcp sport @reachports accept",
    "  }",
    "}",
    "",
  ].join("\n");
}

const listed = z.object({
  nftables: z.array(z.record(z.string(), z.unknown())),
});

type Listed = {
  marker: string | null;
  addresses: string[];
  ports: number[];
  drops: boolean;
};

// What a holder's table holds, from `nft -j list table`.
export function readRules(output: string): Listed | null {
  const start = output.indexOf("{");
  if (start === -1) return null;
  let parsed;
  try {
    parsed = listed.parse(JSON.parse(output.slice(start)));
  } catch {
    return null;
  }
  const of = (kind: string) =>
    parsed.nftables.flatMap((each) =>
      Object.hasOwn(each, kind) ? [each[kind] as Record<string, unknown>] : [],
    );
  const setOf = (name: string) =>
    (of("set").find((each) => each.name === name)?.elem ?? []) as unknown[];
  const chains = of("chain");
  const drops = ["output", "input"].every((hook) =>
    chains.some((chain) => chain.hook === hook && chain.policy === "drop"),
  );
  const comment = of("table")[0]?.comment;
  return {
    marker: typeof comment === "string" ? comment : null,
    addresses: setOf("reach").map(String).sort(),
    ports: setOf("reachports")
      .map(Number)
      .sort((a, b) => a - b),
    drops,
  };
}

// The policy's core run and count, from what a holder's rules say.
function versionOf(rules: Listed | null) {
  const match = /^sanctum (\S+) (\d+)$/.exec(rules?.marker ?? "");
  return match ? { core: match[1]!, count: Number(match[2]) } : null;
}

export type LanDockerLike = DockerClientLike;

// Docker's answer for a container's logs, as text: dockerode hands over one
// that reads as JSON, as nft -j's does, already parsed.
function textOf(logs: unknown) {
  if (Buffer.isBuffer(logs)) return logs.toString("utf8");
  if (typeof logs === "string") return logs;
  return JSON.stringify(logs) ?? "";
}

export function createLanHolders(options: {
  docker: LanDockerLike;
  // The image holders and helpers run from: the manager's own.
  image: () => Promise<string>;
  // This run of the manager, which every confirmation names.
  run: string;
  // Whether an address may be reached at all now, checked again for every
  // policy, as the host's own addresses and Docker's networks can change.
  reachable: (address: string) => boolean;
  log: Log;
}) {
  const { docker, run, log } = options;
  // What each holder's rules hold, by its id, as this manager loaded them.
  const loaded = new Map<string, { core: string; count: number }>();

  async function inspectHolder(name: string) {
    const holder = await inspectContainer(docker, name);
    if (holder)
      assertManaged({ labels: holder.Config.Labels, name }, holderRole);
    return holder;
  }

  // Runs the helper in a holder's network, with `script` given the rules.
  async function helper(
    holder: string,
    app: string,
    script: string,
    rules = "",
  ) {
    const name = stacked(`sanctum-app-${app}-rules`);
    const stale = await inspectContainer(docker, name);
    if (stale) {
      assertManaged({ labels: stale.Config.Labels, name }, rulesRole);
      await docker.getContainer(stale.Id).remove({ force: true });
    }
    const { id } = await docker.createContainer({
      name,
      Image: await options.image(),
      Cmd: ["sh", "-c", script],
      Env: [`SANCTUM_RULES=${rules}`],
      // Its output, unframed, as its logs.
      Tty: true,
      Labels: { ...managedLabels(rulesRole), [appLabel]: app },
      HostConfig: {
        NetworkMode: `container:${holder}`,
        CapDrop: ["ALL"],
        CapAdd: ["NET_ADMIN"],
        SecurityOpt: ["no-new-privileges"],
        ReadonlyRootfs: true,
        RestartPolicy: { Name: "no" },
      },
    });
    const container = docker.getContainer(id) as WaitableContainerLike & {
      logs: (options: { stdout: boolean; stderr: boolean }) => Promise<unknown>;
    };
    try {
      await container.start();
      const { StatusCode } = await container.wait();
      const output = textOf(
        await container.logs({ stdout: true, stderr: true }),
      );
      return { code: StatusCode, output };
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  // Loads a policy into a holder's network and reads it back.
  async function load(holder: string, app: string, wanted: LanPolicy) {
    const policy = {
      ...wanted,
      addresses: wanted.addresses.filter((address) => {
        if (options.reachable(address)) return true;
        log(`${app} can't reach ${address}, which isn't on the home's network`);
        return false;
      }),
    };
    const { code, output } = await helper(
      holder,
      app,
      `printf '%s\\n' "$SANCTUM_RULES" | nft -f - && nft -j list table ${table}`,
      rulesFor(policy),
    );
    const read = code === 0 ? readRules(output) : null;
    const as = (values: readonly (string | number)[]) =>
      JSON.stringify([...new Set(values)].sort());
    if (
      !read?.drops ||
      read.marker !== marker(policy) ||
      as(read.addresses) !== as(policy.addresses) ||
      as(read.ports) !== as(policy.ports)
    ) {
      throw new AppRefusal(
        `${app}'s network didn't take its rules (${output.trim().slice(0, 200)})`,
        500,
      );
    }
    loaded.set(holder, { core: policy.core, count: policy.count });
    return {
      core: policy.core,
      count: policy.count,
      manager: run,
      holder,
    } satisfies LanVersion;
  }

  // What a holder's rules hold now: as this manager loaded them, or as its
  // table says, as after the manager restarted.
  async function heldBy(holder: string, app: string) {
    const known = loaded.get(holder);
    if (known) return known;
    const { code, output } = await helper(
      holder,
      app,
      `nft -j list table ${table}`,
    );
    const version = code === 0 ? versionOf(readRules(output)) : null;
    if (version) loaded.set(holder, version);
    return version;
  }

  async function loadNewer(holder: string, app: string, policy: LanPolicy) {
    const held = await heldBy(holder, app);
    if (held && held.core === policy.core && held.count >= policy.count) {
      throw new AppRefusal(
        `${app}'s network holds a policy as new as that`,
        409,
      );
    }
    return load(holder, app, policy);
  }

  async function removeNamed(name: string) {
    const existing = await inspectHolder(name);
    if (!existing) return;
    loaded.delete(existing.Id);
    await docker.getContainer(existing.Id).remove({ force: true });
  }

  return {
    /**
     * A new holder for the app, its rules loaded, waiting beside the one it
     * replaces until `settle`: its id, and the policy its rules hold.
     */
    async make(app: string, policy: LanPolicy) {
      const network = lanNetworkName(app);
      await ensureNetwork(docker, network, {
        labels: { [appLabel]: app },
      });
      await removeNamed(nextHolderName(app));
      const { id } = await docker.createContainer({
        name: nextHolderName(app),
        Image: await options.image(),
        Cmd: ["sleep", "2147483647"],
        User: "65534:65534",
        Labels: { ...managedLabels(holderRole), [appLabel]: app },
        HostConfig: {
          NetworkMode: network,
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          PidsLimit: 8,
          // Its stop ends it at once: it holds nothing to save.
          Init: true,
          Sysctls: { "net.ipv6.conf.all.disable_ipv6": "1" },
          RestartPolicy: { Name: "no" },
        },
      });
      const container = docker.getContainer(id);
      try {
        await container.start();
        const version = await load(id, app, policy);
        log(`${app}'s network holds its rules`);
        return { id, version };
      } catch (error) {
        await container.remove({ force: true }).catch(() => undefined);
        loaded.delete(id);
        throw error;
      }
    },

    /** The new holder takes the place of the one before, which goes. */
    async settle(app: string) {
      await removeNamed(holderName(app));
      const next = await inspectHolder(nextHolderName(app));
      if (next) {
        await docker.getContainer(next.Id).rename({ name: holderName(app) });
      }
    },

    /** The app's running holder, if it has one. */
    async running(app: string) {
      const holder = await inspectHolder(holderName(app));
      return holder?.State.Running ? holder : null;
    },

    /**
     * Replaces what the app's network may reach, in the holder the change
     * names: refused when that isn't the app's holder now, or when its rules
     * hold a policy as new from the same run of the core.
     */
    async apply(app: string, change: z.infer<typeof lanChange>) {
      const holder = await inspectHolder(holderName(app));
      if (!holder?.State.Running || holder.Id !== change.holder) {
        throw new AppRefusal(`${app}'s network isn't that holder's`, 409);
      }
      const { manager: _, holder: __, ...policy } = change;
      return loadNewer(holder.Id, app, policy);
    },

    /**
     * The policy of a core that started again, for the holder of the
     * container it keeps.
     */
    keep(app: string, holder: ContainerInfo, policy: LanPolicy) {
      return loadNewer(holder.Id, app, policy);
    },

    /** A new holder that won't be used goes. */
    discard(app: string) {
      return removeNamed(nextHolderName(app));
    },

    /** Whether the app's container shares this holder's network. */
    shares(container: ContainerInfo, holder: ContainerInfo) {
      return container.HostConfig.NetworkMode === `container:${holder.Id}`;
    },

    /** Its holders and network go, as when the app does. */
    async remove(app: string) {
      await removeNamed(nextHolderName(app));
      await removeNamed(holderName(app));
      const network = lanNetworkName(app);
      const inspected = await docker
        .getNetwork(network)
        .inspect()
        .catch((error: unknown) => {
          if (isNotFound(error)) return null;
          throw error;
        });
      if (!inspected) return;
      assertManaged({ labels: inspected.Labels, name: `${network} network` });
      log(`Removing ${network}`);
      await docker.getNetwork(network).remove();
    },

    /** Its holder stops with it. */
    async stop(app: string) {
      const holder = await inspectHolder(holderName(app));
      if (holder?.State.Running) {
        await docker.getContainer(holder.Id).stop({ t: 1 });
      }
    },
  };
}

export type LanHolders = ReturnType<typeof createLanHolders>;
