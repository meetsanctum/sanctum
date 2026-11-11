import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHostStateStore,
  createHostStateWriter,
  writeJson,
  type HostState,
} from "../src/state.js";

const durable = vi.hoisted(() => ({
  synced: [] as string[],
  onSync: async (_path: string) => {},
}));

vi.mock("../src/durable.js", async (original) => {
  const real = await original<typeof import("../src/durable.js")>();
  return {
    ...real,
    syncPath: async (path: string) => {
      durable.synced.push(path);
      await durable.onSync(path);
      await real.syncPath(path);
    },
  };
});

beforeEach(() => {
  durable.synced = [];
  durable.onSync = async () => {};
});

describe("writing a state file", () => {
  it("syncs the new file before it takes the name, and the folder after", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sanctum-state-"));
    const file = join(dir, "state.json");
    await writeFile(file, JSON.stringify({ was: "before" }));
    const seen: Array<{ path: string; holds: unknown }> = [];
    durable.onSync = async (path) => {
      seen.push({
        path: basename(path).replace(/\.[0-9a-f-]{36}\.tmp$/, ".tmp"),
        holds: JSON.parse(await readFile(file, "utf8")),
      });
    };

    await writeJson(file, { was: "after" });

    expect(seen).toEqual([
      { path: "state.json.tmp", holds: { was: "before" } },
      { path: basename(dir), holds: { was: "after" } },
    ]);
    expect(await readdir(dir)).toEqual(["state.json"]);
  });

  it("syncs every parent of the folders it had to make", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sanctum-state-"));

    await writeJson(join(dir, "new/deep/state.json"), {});

    expect(durable.synced.slice(0, 2)).toEqual([join(dir, "new"), dir]);
    expect(durable.synced.at(-1)).toBe(join(dir, "new/deep"));
  });
});

describe("host state", () => {
  it("makes the host's id on the first start and keeps it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sanctum-state-"));
    const first = await createHostStateStore(dir).load();
    const again = await createHostStateStore(dir).load();
    expect(first.hostId).toMatch(/^[0-9a-f-]{36}$/);
    expect(again).toEqual(first);
  });

  it("gives a file without a host id one, and keeps what else it holds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sanctum-state-"));
    const file = join(dir, "state.json");
    await writeFile(
      file,
      JSON.stringify({ coreImage: "sha256:c0re", claimed: true }),
    );

    const state = await createHostStateStore(dir).load();

    expect(state).toMatchObject({ coreImage: "sha256:c0re", claimed: true });
    expect(state.hostId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(state);
  });
});

describe("host state changes", () => {
  it("keeps failed changes out of memory and retries the same value", async () => {
    const state: HostState = { hostId: "host", claimed: false };
    const save = vi
      .fn<(state: HostState) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Disk full"))
      .mockResolvedValue(undefined);
    const write = createHostStateWriter(state, save);

    await expect(write({ claimed: true })).rejects.toThrow("Disk full");
    expect(state.claimed).toBe(false);
    await write({ claimed: true });

    expect(state.claimed).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("publishes only saved state and preserves concurrent changes", async () => {
    const state: HostState = { hostId: "host", claimed: false };
    let finishSave!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const saved: HostState[] = [];
    const write = createHostStateWriter(state, async (next) => {
      if (saved.length === 0) await firstSave;
      saved.push(next);
    });

    const claim = write({ claimed: true });
    const update = write({ coreImage: "sha256:new" });
    expect(state).toEqual({ hostId: "host", claimed: false });
    finishSave();
    await Promise.all([claim, update]);

    expect(saved).toEqual([
      { hostId: "host", claimed: true },
      { hostId: "host", claimed: true, coreImage: "sha256:new" },
    ]);
    expect(state).toEqual(saved[1]);
  });

  it("does not carry a rejected change into the next queued save", async () => {
    const state: HostState = { hostId: "host", claimed: false };
    const save = vi
      .fn<(state: HostState) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Disk full"))
      .mockResolvedValue(undefined);
    const write = createHostStateWriter(state, save);

    const claim = write({ claimed: true });
    const update = write({ coreImage: "sha256:new" });
    await expect(claim).rejects.toThrow("Disk full");
    await update;

    expect(save).toHaveBeenLastCalledWith({
      hostId: "host",
      claimed: false,
      coreImage: "sha256:new",
    });
    expect(state.claimed).toBe(false);
  });

  it("applies a queued value even when it matches the current state", async () => {
    const state: HostState = { hostId: "host", claimed: false };
    const save = vi
      .fn<(state: HostState) => Promise<void>>()
      .mockResolvedValue(undefined);
    const write = createHostStateWriter(state, save);

    await Promise.all([write({ claimed: true }), write({ claimed: false })]);

    expect(save).toHaveBeenLastCalledWith({ hostId: "host", claimed: false });
    expect(state.claimed).toBe(false);
  });
});
