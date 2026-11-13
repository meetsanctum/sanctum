import { defineConfig } from "vitest/config";

// Only this folder's tests: the built site under .next holds copies of
// packages, and their tests are not the site's.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
