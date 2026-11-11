import { defineConfig } from "drizzle-kit";

// The notes fixture's migrations. Generate from apps/core with
// `pnpm exec drizzle-kit generate --config test/fixtures/apps/notes/drizzle.config.ts`.
export default defineConfig({
  dialect: "sqlite",
  schema: "./test/fixtures/apps/notes/schema.ts",
  out: "./test/fixtures/apps/notes/migrations",
});
