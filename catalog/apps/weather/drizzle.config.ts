import { defineConfig } from "drizzle-kit";

// Weather's own database (src/schema.ts). Generate with
// `pnpm db:generate --name <change>`; never edit the generated files.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./migrations",
});
