import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildManifest, manifestCommand, snapshotFile } from "../src/cli.js";
import { snapshotText } from "../src/contract.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture(packageJson: object = { exports: { ".": "./app.js" } }) {
  const root = mkdtempSync(join(tmpdir(), "sanctum-contract-"));
  directories.push(root);
  const directory = join(root, "catalog", "apps", "bare");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ type: "module", ...packageJson }),
  );
  writeFileSync(
    join(directory, "app.js"),
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
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Contract test");
  git("config", "user.email", "contract@example.test");
  const commit = () => {
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Fixture");
    return git("rev-parse", "HEAD");
  };
  return { directory, commit };
}

describe("built package entries", () => {
  it.each([
    { exports: "./app.js" },
    { exports: { ".": "./app.js" } },
    { exports: { ".": { import: "./app.js", default: "./missing.js" } } },
    { exports: { ".": { default: "./app.js" } } },
    { exports: { import: "./app.js", default: "./missing.js" } },
    { exports: { default: "./app.js" } },
    { main: "./app.js" },
  ])("loads the core's supported entry format: %j", async (packageJson) => {
    const { directory } = createFixture(packageJson);
    expect(await buildManifest(directory)).toMatchObject({ id: "test.bare" });
  });
});

describe("writing the snapshot", () => {
  it("replaces it whole, leaving nothing else behind", async () => {
    const { directory } = createFixture();
    const file = join(directory, snapshotFile);
    const current = await buildManifest(directory);
    const earlier = JSON.stringify({
      ...current,
      events: [{ id: "bare.removed", payload: {} }],
    });
    writeFileSync(file, earlier);
    await expect(manifestCommand(directory, { check: false })).rejects.toThrow(
      "takes away event bare.removed",
    );
    // A refused write leaves the old snapshot as it was.
    expect(readFileSync(file, "utf8")).toBe(earlier);

    writeFileSync(file, snapshotText(current));
    await expect(manifestCommand(directory, { check: false })).resolves.toBe(
      "wrote sanctum-app.json for test.bare",
    );
    expect(readFileSync(file, "utf8")).toBe(snapshotText(current));
    expect(readdirSync(directory).sort()).toEqual([
      "app.js",
      "package.json",
      snapshotFile,
    ]);
  });
});

describe("checking a Git base", () => {
  it("permits a new snapshot when the base has none", async () => {
    const { directory, commit } = createFixture();
    const base = commit();
    await manifestCommand(directory, { check: false });
    await expect(
      manifestCommand(directory, { check: true, base }),
    ).resolves.toContain("is current");
  });

  it("rejects an unavailable ref instead of skipping the check", async () => {
    const { directory, commit } = createFixture();
    commit();
    await manifestCommand(directory, { check: false });
    await expect(
      manifestCommand(directory, { check: true, base: "missing-base" }),
    ).rejects.toThrow("missing-base");
  });

  it("checks the snapshot at the app's nested path without writing it", async () => {
    const { directory, commit } = createFixture();
    const current = await buildManifest(directory);
    const file = join(directory, snapshotFile);
    writeFileSync(
      file,
      JSON.stringify({
        ...current,
        events: [{ id: "bare.removed", payload: {} }],
      }),
    );
    const base = commit();
    writeFileSync(file, snapshotText(current));
    await expect(
      manifestCommand(directory, { check: true, base }),
    ).rejects.toThrow("takes away event bare.removed");
    expect(readFileSync(file, "utf8")).toBe(snapshotText(current));
  });

  it("rejects an empty base snapshot instead of treating it as absent", async () => {
    const { directory, commit } = createFixture();
    const file = join(directory, snapshotFile);
    writeFileSync(file, "");
    const base = commit();
    writeFileSync(file, snapshotText(await buildManifest(directory)));
    await expect(
      manifestCommand(directory, { check: true, base }),
    ).rejects.toThrow();
  });
});
