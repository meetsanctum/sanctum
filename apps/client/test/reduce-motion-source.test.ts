import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Reduce motion reaches every part through data-motion on <html>: the
// theme's `motion-reduce:` and `motion-safe:`, CSS under
// [data-motion="reduced"], and useReducedMotion or isMotionReduced in
// script. The system's reduced motion is read in two places only, the
// shell's (src/effects.ts) and the frame runtime's for a shell that doesn't
// say, so a part that read it itself would move on a device set to Reduce
// motion, or stay still on one set to Off.

const root = fileURLToPath(new URL("../../..", import.meta.url));
const readers = [
  "apps/client/src/effects.ts",
  "packages/ui-sdk/src/frame/runtime.tsx",
];

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
