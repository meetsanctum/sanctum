import { defineConfig } from "vitest/config";

// The tests that run real containers, apart from `pnpm test`: they need Docker
// and take minutes.
export default defineConfig({
  test: {
    include: ["test/**/*.docker.ts"],
    // Each builds images and runs a host's worth of containers.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
