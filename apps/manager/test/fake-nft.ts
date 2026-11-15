import type { ContainerCreateOptions } from "../src/docker.js";
import type { FakeDocker } from "./fake-docker.js";

// A stand-in for nft in the helper that loads an app's network's rules
// (src/apps/lan.ts): it keeps each holder's rules as the helper loads them,
// and lists them as nft -j does.

// What nft lists for a table loaded from these rules.
export function listing(rules: string) {
  const comment = /comment "([^"]+)"/.exec(rules)?.[1];
  const elements = (set: string) => {
    const found = new RegExp(
      `set ${set} \\{ type [a-z_0-9]+;(?: elements = \\{ ([^}]*) \\};)? \\}`,
    ).exec(rules)?.[1];
    return found ? found.split(", ") : undefined;
  };
  const reach = elements("reach");
  const ports = elements("reachports")?.map(Number);
  return JSON.stringify({
    nftables: [
      { metainfo: { version: "1.1.6" } },
      { table: { family: "inet", name: "sanctum", comment } },
      { chain: { name: "output", hook: "output", policy: "drop" } },
      { chain: { name: "input", hook: "input", policy: "drop" } },
      { set: { name: "reach", ...(reach ? { elem: reach } : {}) } },
      { set: { name: "reachports", ...(ports ? { elem: ports } : {}) } },
    ],
  });
}

export function playNft(docker: FakeDocker) {
  // Each holder's rules, by its id, as last loaded.
  const tables = new Map<string, string>();
  const loads: { holder: string; rules: string }[] = [];
  docker.onRun = (options: ContainerCreateOptions) => {
    const script = options.Cmd?.[2] ?? "";
    if (!script.includes("nft")) return null;
    const holder = String(options.HostConfig?.NetworkMode).replace(
      "container:",
      "",
    );
    if (script.includes("nft -f -")) {
      const rules = (options.Env ?? [])
        .find((each) => each.startsWith("SANCTUM_RULES="))!
        .slice("SANCTUM_RULES=".length);
      tables.set(holder, rules);
      loads.push({ holder, rules });
    }
    const rules = tables.get(holder);
    return rules
      ? { code: 0, output: listing(rules) }
      : { code: 1, output: "Error: No such file or directory" };
  };
  return { tables, loads };
}
