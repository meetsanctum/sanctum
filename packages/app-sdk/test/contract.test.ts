import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildManifest, decide } from "../src/cli.js";
import {
  brokenPromises,
  compatibleLine,
  isOlderVersion,
  snapshotText,
  withOldestPage,
} from "../src/contract.js";
import { defineAction, defineApp, toStaticManifest } from "../src/index.js";

// Contract snapshots: an app's committed sanctum-app.json, kept current,
// that may not lose an action, event, setting or widget without a new major
// version.

const action = (id: string) =>
  defineAction({
    id,
    title: id,
    tier: "read",
    input: z.object({}),
    output: z.object({}),
    run: async () => ({}),
  });

function manifest(version: string, actions: string[], events: string[] = []) {
  return toStaticManifest(
    defineApp({
      id: "test.example",
      name: "Example",
      version,
      core: "^1.0.0",
      permissions: [],
      actions: actions.map(action),
      events: events.map((id) => ({ id, payload: z.object({}) })),
    }),
  );
}

describe("brokenPromises", () => {
  it("names what a manifest takes away, a rename included", () => {
    expect(
      brokenPromises(
        manifest("1.2.0", ["example.add", "example.clear"], ["example.added"]),
        manifest("1.3.0", ["example.add", "example.empty"]),
      ),
    ).toEqual(["action example.clear", "event example.added"]);
  });

  it("allows additions, and anything in a new major version", () => {
    expect(
      brokenPromises(
        manifest("1.2.0", ["example.add"]),
        manifest("1.2.1", ["example.add", "example.clear"]),
      ),
    ).toEqual([]);
    expect(
      brokenPromises(manifest("1.2.0", ["example.add"]), manifest("2.0.0", [])),
    ).toEqual([]);
  });

  it("takes the minor as the major below 1.0", () => {
    expect(compatibleLine("0.1.4")).toBe("0.1");
    expect(compatibleLine("0.0.3")).toBe("0.0.3");
    expect(compatibleLine("2.5.0-beta.1")).toBe("2");
    expect(
      brokenPromises(manifest("0.1.0", ["example.add"]), manifest("0.1.1", [])),
    ).toEqual(["action example.add"]);
    expect(
      brokenPromises(manifest("0.1.0", ["example.add"]), manifest("0.2.0", [])),
    ).toEqual([]);
  });

  it.each([
    ["2.0.0", "1.0.0"],
    ["1.0.0", "0.9.0"],
    ["0.2.0", "0.1.0"],
    ["0.1.0", "0.0.9"],
    ["0.0.3", "0.0.2"],
    ["10.0.0", "2.0.0"],
  ])("does not allow removals by downgrading %s to %s", (earlier, next) => {
    expect(
      brokenPromises(manifest(earlier, ["example.add"]), manifest(next, [])),
    ).toEqual(["action example.add"]);
  });

  it.each([
    ["0.0.3", "0.0.4"],
    ["0.0.9", "0.1.0"],
    ["0.9.0", "1.0.0"],
    ["2.0.0", "10.0.0"],
  ])("allows removals when advancing %s to %s", (earlier, next) => {
    expect(
      brokenPromises(manifest(earlier, ["example.add"]), manifest(next, [])),
    ).toEqual([]);
  });

  it("covers what an app provides, and its settings", () => {
    const earlier = {
      version: "1.0.0",
      settings: { properties: { defaultList: {}, sort: {} } },
      provides: {
        entities: [{ id: "example.list" }, { id: "example.item" }],
        widgets: [{ id: "example.board" }],
      },
    };
    expect(
      brokenPromises(
        earlier as never,
        {
          version: "1.1.0",
          settings: { properties: { defaultList: {} } },
          provides: { entities: [{ id: "example.list" }], widgets: [] },
        } as never,
      ),
    ).toEqual(["entity example.item", "widget example.board", "setting sort"]);
  });
});

describe("settings in the contract", () => {
  const withSettings = (version: string, settings: z.ZodObject) =>
    toStaticManifest(
      defineApp({
        id: "test.weather",
        name: "Weather",
        version,
        core: "^1.0.0",
        permissions: [],
        actions: [],
        events: [],
        settings,
      }),
    );
  const unit = z
    .enum(["celsius", "fahrenheit"])
    .default("celsius")
    .meta({
      title: "Unit",
      options: { celsius: "Celsius", fahrenheit: "Fahrenheit" },
    });

  it("lose a setting only with a new major version", () => {
    const earlier = withSettings("0.1.0", z.object({ unit }));
    const renamed = z.object({ temperatureUnit: unit });

    expect(brokenPromises(earlier, withSettings("0.1.1", renamed))).toEqual([
      "setting unit",
    ]);
    expect(brokenPromises(earlier, withSettings("0.2.0", renamed))).toEqual([]);
  });
});

describe("the snapshot", () => {
  const current = manifest("1.0.0", ["example.add"]);

  it("is written as it is, unless it breaks the committed one", () => {
    expect(decide(current, undefined, { check: false })).toEqual({
      write: snapshotText(current),
      message: "wrote sanctum-app.json for test.example",
    });
    const earlier = snapshotText(
      manifest("1.0.0", ["example.add", "example.clear"]),
    );
    expect(() => decide(current, earlier, { check: false })).toThrow(
      "test.example 1.0.0 takes away action example.clear from its sanctum-app.json without a new major version",
    );
  });

  it("fails a check when it is missing or stale, and writes nothing", () => {
    expect(decide(current, snapshotText(current), { check: true })).toEqual({
      message: "sanctum-app.json for test.example is current",
    });
    expect(() => decide(current, undefined, { check: true })).toThrow(
      "sanctum-app.json for test.example is missing: run `pnpm manifest` and commit it",
    );
    expect(() =>
      decide(current, snapshotText(manifest("1.0.0", [])), { check: true }),
    ).toThrow("is out of date");
  });

  it("fails a check that breaks the base branch's", () => {
    const base = {
      ref: "origin/main",
      text: snapshotText(manifest("1.0.0", ["example.add", "example.clear"])),
    };
    expect(() =>
      decide(current, snapshotText(current), { check: true, base }),
    ).toThrow("takes away action example.clear from origin/main");
    const next = manifest("2.0.0", []);
    expect(
      decide(next, snapshotText({ ...next, oldestPage: "2.0.0" }), {
        check: true,
        base,
      }).message,
    ).toBe("sanctum-app.json for test.example is current");
  });

  it("is built from the package's main entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sanctum-app-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ type: "module", exports: { ".": "./app.js" } }),
    );
    await expect(buildManifest(dir)).rejects.toThrow(
      "No ./app.js: build the app first",
    );
    // A built app with no actions needs nothing it would import.
    writeFileSync(
      join(dir, "app.js"),
      `export default ${JSON.stringify({
        id: "test.bare",
        name: "Bare",
        version: "0.1.0",
        core: "^1.0.0",
        permissions: [],
        actions: [],
        events: [],
      })};`,
    );
    expect(await buildManifest(dir)).toMatchObject({
      id: "test.bare",
      version: "0.1.0",
      actions: [],
    });
  });
});

describe("the oldest of its pages an app works with", () => {
  it("is raised by a version that takes something away", () => {
    const earlier = manifest("1.0.0", ["example.add", "example.clear"]);

    expect(
      withOldestPage(manifest("2.0.0", ["example.add"]), earlier).oldestPage,
    ).toBe("2.0.0");
  });

  it("stays where it was while nothing more is taken away", () => {
    const earlier = {
      ...manifest("2.0.0", ["example.add"]),
      oldestPage: "2.0.0",
    };

    expect(
      withOldestPage(
        manifest("2.1.0", ["example.add", "example.more"]),
        earlier,
      ).oldestPage,
    ).toBe("2.0.0");
  });

  it("is nothing until something has been", () => {
    const earlier = manifest("1.0.0", ["example.add"]);

    expect(
      withOldestPage(
        manifest("1.1.0", ["example.add", "example.more"]),
        earlier,
      ),
    ).not.toHaveProperty("oldestPage");
    expect(withOldestPage(manifest("1.0.0", []), undefined)).not.toHaveProperty(
      "oldestPage",
    );
  });

  it("is written by pnpm manifest, and kept when it's run again", () => {
    const earlier = snapshotText(manifest("1.0.0", ["example.add"]));
    const next = manifest("2.0.0", []);

    const { write } = decide(next, earlier, { check: false });

    expect(JSON.parse(write!)).toMatchObject({ oldestPage: "2.0.0" });
    expect(decide(next, write, { check: false }).write).toBe(write);
    expect(decide(next, write, { check: true }).write).toBeUndefined();
  });

  it("makes a check fail if the file doesn't say what was taken away", () => {
    const stale = snapshotText(manifest("2.0.0", ["example.add"]));

    expect(() => decide(manifest("2.0.0", []), stale, { check: true })).toThrow(
      "out of date",
    );
  });
});

describe("the page floor checked against the base branch", () => {
  it("covers removals from the base branch", () => {
    const base = {
      ref: "origin/main",
      text: snapshotText(manifest("1.0.0", ["example.add"])),
    };
    const next = manifest("2.1.0", []);

    for (const oldestPage of [undefined, "1.0.0", "1.1.0"]) {
      expect(() =>
        decide(next, snapshotText({ ...next, oldestPage }), {
          check: true,
          base,
        }),
      ).toThrow("oldestPage");
    }
    // The removal may have been generated before another version bump.
    expect(
      decide(next, snapshotText({ ...next, oldestPage: "2.0.0" }), {
        check: true,
        base,
      }).message,
    ).toContain("is current");
  });

  it("doesn't let the page floor fall below the base branch's", () => {
    const base = {
      ref: "origin/main",
      text: snapshotText({ ...manifest("2.1.0", []), oldestPage: "2.0.0" }),
    };
    const next = manifest("2.2.0", []);

    for (const oldestPage of [undefined, "1.0.0"]) {
      expect(() =>
        decide(next, snapshotText({ ...next, oldestPage }), {
          check: true,
          base,
        }),
      ).toThrow("oldestPage");
    }
    expect(
      decide(next, snapshotText({ ...next, oldestPage: "2.0.0" }), {
        check: true,
        base,
      }).message,
    ).toContain("is current");
  });
});

describe("isOlderVersion", () => {
  it.each([
    ["0.8.0", "0.9.0", true],
    ["0.9.0", "0.9.0", false],
    ["0.10.0", "0.9.0", false],
    ["0.9.0", "0.10.0", true],
    ["1.0.0", "0.99.99", false],
    ["1.2.3", "1.2.4", true],
    ["1.2.3-rc.1", "1.2.3", false],
    ["1.2.3+abc", "1.2.3", false],
  ])("%s before %s: %s", (version, than, older) => {
    expect(isOlderVersion(version, than)).toBe(older);
  });
});
