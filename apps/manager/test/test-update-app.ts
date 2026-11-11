// A package for the tests of apps' updates and moves: another app's dependencies,
// with its own code, a real table and a manifest. What its start does is up to each
// version, and it says what it holds through its actions.

// An app with a real table, whose start does what each version is told.
const code = (app: string, version: string, start: string) => `
import { defineAction, defineApp, NotReady } from "@meetsanctum/app-sdk";
import { sql } from "drizzle-orm";
import { z } from "zod";

const action = (id, run) =>
  defineAction({ id, title: id, tier: "write", input: z.object({}).passthrough(), output: z.unknown(), run });

export default defineApp({
  id: "${app}",
  name: "Updater",
  version: "${version}",
  core: "^1.0.0",
  migrations: "migrations",
  permissions: [],
  events: [],
  runtime: { memory: 64, data: 64 },
  actions: [
    action("updater.write", async (ctx, input) => {
      await ctx.storage.db.run(sql\`INSERT INTO notes (text) VALUES (\${input.text})\`);
      return null;
    }),
    action("updater.read", async (ctx) => {
      const rows = await ctx.storage.db.all(sql\`SELECT text FROM notes\`);
      return rows.map((row) => row.text ?? row[0]);
    }),
  ],
  async start(ctx, info) {
    ${start}
  },
});
`;

const makeManifest = `
import { toStaticManifest } from "@meetsanctum/app-sdk";
import { writeFileSync } from "node:fs";
const { default: app } = await import(process.cwd() + "/dist/index.js");
writeFileSync("sanctum-app.json", JSON.stringify(toStaticManifest(app)));
`;

// It goes in this folder under /data/packages, from another app's package there.
export async function stageTestApp(
  docker: (...args: string[]) => Promise<string>,
  manager: string,
  options: {
    app: string;
    from: string;
    parent: string;
    folder: string;
    version: string;
    start: string;
  },
) {
  const { app, from, parent, folder, version, start } = options;
  const path = `/data/packages/${parent}/${folder}`;
  await docker("exec", manager, "mkdir", "-p", `/data/packages/${parent}`);
  await docker("exec", manager, "cp", "-a", from, path);
  await docker(
    "exec",
    manager,
    "node",
    "-e",
    `const fs = require("node:fs");
     const at = (each) => ${JSON.stringify(path)} + "/" + each;
     fs.rmSync(at("dist"), { recursive: true, force: true });
     fs.rmSync(at("migrations"), { recursive: true, force: true });
     fs.mkdirSync(at("dist"));
     fs.mkdirSync(at("migrations/meta"), { recursive: true });
     fs.writeFileSync(at("dist/index.js"), ${JSON.stringify(code(app, version, start))});
     fs.writeFileSync(at("package.json"), JSON.stringify({
       name: "test-updater", version: ${JSON.stringify(version)}, type: "module", exports: { ".": "./dist/index.js" },
     }));
     fs.writeFileSync(at("migrations/0000_notes.sql"), "CREATE TABLE notes (text TEXT NOT NULL);");
     fs.writeFileSync(at("migrations/meta/_journal.json"), JSON.stringify({
       version: "7", dialect: "sqlite",
       entries: [{ idx: 0, version: "6", when: 1, tag: "0000_notes", breakpoints: true }],
     }));`,
  );
  await docker(
    "exec",
    "--workdir",
    path,
    manager,
    "node",
    "--no-warnings",
    "--input-type=module",
    "-e",
    makeManifest,
  );
}
