import { defineConfig } from "drizzle-kit";

// Moods' own database (src/moods/schema.ts). Generate with
// `pnpm db:generate --name <change>`; never edit the generated files.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/moods/schema.ts",
  out: "./migrations",
});
