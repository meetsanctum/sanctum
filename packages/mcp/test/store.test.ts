import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  fileTokens,
  listConnections,
  loadConnection,
  removeConnection,
  saveConnection,
  storeDir,
  type Connection,
} from "../src/store.js";

// What the connector keeps on this computer.

async function folder() {
  const dir = await mkdtemp(join(tmpdir(), "sanctum-mcp-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const office: Connection = {
  clientId: "8b0d3c1e-5a2f-4c7e-8d3b-6f1e2a9c0b47",
  name: "sanctum-office",
  agent: "claude",
  homeId: "3f6d1c2a-8e1b-4d6f-9a51-1d1d1f6e6e73",
  anchor: null,
  url: "https://192.168.7.2:8443",
};

describe("the connector's store", () => {
  it("keeps connections, one file each", async () => {
    const dir = await folder();
    await saveConnection(dir, office);

    expect(await loadConnection(dir, office.clientId)).toEqual(office);
    expect(await listConnections(dir)).toEqual([office]);
    expect((await stat(join(dir, "connections"))).mode & 0o777).toBe(0o700);

    await removeConnection(dir, office.clientId);
    expect(await listConnections(dir)).toEqual([]);
  });

  it("never reads a path from a connection's id", async () => {
    const dir = await folder();
    await expect(
      loadConnection(dir, "../../etc/passwd"),
    ).resolves.toBeUndefined();
    await expect(fileTokens(dir).set("../x", "token")).rejects.toThrow();
  });

  it("keeps a token where there's no secure storage only for this user", async () => {
    const dir = await folder();
    const tokens = fileTokens(dir);

    await tokens.set(office.clientId, "client_secret");

    expect(await tokens.get(office.clientId)).toBe("client_secret");
    expect(
      (await stat(join(dir, "tokens", office.clientId))).mode & 0o777,
    ).toBe(0o600);
    await tokens.delete(office.clientId);
    expect(await tokens.get(office.clientId)).toBeUndefined();
  });

  it("lives where the system keeps settings, unless told", () => {
    expect(storeDir({ SANCTUM_MCP_DIR: "/tmp/here" })).toBe("/tmp/here");
    expect(storeDir({ XDG_CONFIG_HOME: "/home/x/.config" })).toBe(
      "/home/x/.config/sanctum-mcp",
    );
  });
});
