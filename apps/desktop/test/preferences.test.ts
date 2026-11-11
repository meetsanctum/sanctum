import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createPreferenceStore } from "../src/preferences.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

// What the client keeps about how it shows the home, in the app's data
// folder, so it outlives the page's session in memory.

async function store() {
  const path = join(
    await mkdtemp(join(tmpdir(), "sanctum-desktop-")),
    "preferences.json",
  );
  return { path, preferences: createPreferenceStore(path) };
}

describe("the client's preferences", () => {
  it("outlive the store that kept them", async () => {
    const { path, preferences } = await store();
    expect(await preferences.get("dashboard")).toBeNull();

    await preferences.set("dashboard", "kitchen");

    expect(await preferences.get("dashboard")).toBe("kitchen");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      preferences: { dashboard: "kitchen" },
    });
    // As after a restart.
    expect(await createPreferenceStore(path).get("dashboard")).toBe("kitchen");
  });

  it("keep the last of overlapping saves", async () => {
    const { path, preferences } = await store();

    await Promise.all([
      preferences.set("dashboard", "home"),
      preferences.set("dashboard", "kitchen"),
      preferences.set("sidebar", "open"),
    ]);

    const reopened = createPreferenceStore(path);
    expect(await reopened.get("dashboard")).toBe("kitchen");
    expect(await reopened.get("sidebar")).toBe("open");
  });

  it("retry the same value after a failed save", async () => {
    const { path, preferences } = await store();
    await preferences.get("dashboard");
    // A directory at the destination prevents the atomic rename.
    await mkdir(path);
    await expect(preferences.set("dashboard", "kitchen")).rejects.toThrow();
    await rm(path, { recursive: true });

    await preferences.set("dashboard", "kitchen");

    expect(await createPreferenceStore(path).get("dashboard")).toBe("kitchen");
  });

  it("do not report an overlapping identical save as kept when writing fails", async () => {
    const { path, preferences } = await store();
    await preferences.get("dashboard");
    await mkdir(path);

    const saves = await Promise.allSettled([
      preferences.set("dashboard", "kitchen"),
      preferences.set("dashboard", "kitchen"),
    ]);

    expect(saves.map((save) => save.status)).toEqual(["rejected", "rejected"]);
  });

  it("remove temporary files after a failed save", async () => {
    const { path, preferences } = await store();
    await preferences.get("dashboard");
    await mkdir(path);

    await expect(preferences.set("dashboard", "kitchen")).rejects.toThrow();

    expect(await readdir(dirname(path))).toEqual(["preferences.json"]);
  });

  it("are none when the file is missing or unreadable", async () => {
    const { path, preferences } = await store();
    await writeFile(path, "{not json");
    expect(await preferences.get("dashboard")).toBeNull();

    // And saving over it works.
    await preferences.set("dashboard", "kitchen");
    expect(await createPreferenceStore(path).get("dashboard")).toBe("kitchen");
  });

  it("keep a file they could not read until the next start", async () => {
    const { path, preferences } = await store();
    await createPreferenceStore(path).set("sidebar", "open");
    const before = await readFile(path, "utf8");
    vi.mocked(readFile).mockRejectedValueOnce(
      Object.assign(new Error("Resource busy"), { code: "EBUSY" }),
    );

    await expect(preferences.get("dashboard")).rejects.toThrow("busy");
    // As the dashboard's fallback to the first would.
    await expect(preferences.set("dashboard", "home")).rejects.toThrow("busy");

    expect(await readFile(path, "utf8")).toBe(before);
    expect(await createPreferenceStore(path).get("sidebar")).toBe("open");
  });

  it("load only what the store would have kept", async () => {
    const { path } = await store();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        preferences: { dashboard: "kitchen", "../host": "x", other: 1 },
      }),
    );

    const preferences = createPreferenceStore(path);
    expect(await preferences.get("dashboard")).toBe("kitchen");
    expect(await preferences.get("../host")).toBeNull();
    expect(await preferences.get("other")).toBeNull();
  });

  it("refuse what is not a preference, whatever the page asks", async () => {
    const { preferences } = await store();

    for (const [key, value] of [
      ["", "x"],
      ["Dashboard", "x"],
      ["../host", "x"],
      ["k".repeat(65), "x"],
      ["dashboard", 1],
      ["dashboard", null],
      ["dashboard", "x".repeat(4097)],
    ] as const) {
      await expect(
        preferences.set(key, value as unknown as string),
      ).rejects.toThrow(TypeError);
    }
    expect(await preferences.get("dashboard")).toBeNull();
  });

  it("are limited in number", async () => {
    const { preferences } = await store();
    for (let index = 0; index < 64; index += 1) {
      await preferences.set(`key-${index}`, "x");
    }

    await expect(preferences.set("one-more", "x")).rejects.toThrow(RangeError);
    // One already kept may still change.
    await preferences.set("key-0", "y");
    expect(await preferences.get("key-0")).toBe("y");
  });
});
