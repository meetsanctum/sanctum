import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Reduce motion reaches every part through data-motion on <html>: the
// theme's `motion-reduce:` and `motion-safe:`, CSS under
// [data-motion="reduced"], and useReducedMotion or isMotionReduced in
// script. The shell sets it from the client's own switch alone, so a part
// that read the system's reduced motion itself would stay still on a
// device with Reduce motion off. The frame runtime reads it only for a
// shell that doesn't say.

const root = fileURLToPath(new URL("../../..", import.meta.url));
const readers = ["packages/ui-sdk/src/frame/runtime.tsx"];

function sources() {
  const catalog = readdirSync(join(root, "catalog/apps")).map(
    (app) => `catalog/apps/${app}/src`,
  );
  return ["apps/client/src", "packages/ui-sdk/src", ...catalog].flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
      .filter((path) => /\.(tsx?|css)$/.test(path))
      .map((path) => join(dir, path)),
  );
}

it("reads the system's reduced motion only where it becomes data-motion", () => {
  const found = sources().filter((path) =>
    readFileSync(join(root, path), "utf8").includes("prefers-reduced-motion"),
  );
  expect(found.sort()).toEqual(readers);
});
