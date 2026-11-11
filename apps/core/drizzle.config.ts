import { defineConfig } from "drizzle-kit";

// The core database's migrations (src/database.ts). Each of the core's
// modules keeps its tables in its own schema.ts. Generate with
// `pnpm db:generate`; never edit the generated files.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/*/schema.ts",
  out: "./migrations",
});
