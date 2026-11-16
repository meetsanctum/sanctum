import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The container tests build the core and every catalog app before their
// stacks stage them. Turbo builds all of it first, so those builds of their
// own find it built, rather than building it again beside Turbo's: a second
// build of ui-sdk empties its kit while an app's pages read the kit's
// stylesheet.

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) =>
  JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>;

describe("the container tests", () => {
  it("wait for the core's build and every catalog app's", () => {
    const config = read("apps/manager/turbo.json") as {
      tasks: Record<string, { dependsOn: string[] }>;
    };
    const apps = readdirSync(join(root, "catalog/apps")).map(
      (folder) =>
        (read(`catalog/apps/${folder}/package.json`) as { name: string }).name,
    );
    expect(config.tasks["test:containers"]!.dependsOn).toEqual(
      expect.arrayContaining([
        "^build",
        "build",
        "@meetsanctum/core#build",
        ...apps.map((name) => `${name}#build`),
      ]),
    );
  });
});
