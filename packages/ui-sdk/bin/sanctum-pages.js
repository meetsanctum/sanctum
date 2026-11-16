#!/usr/bin/env node
// The `sanctum-pages` command (tools/cli.ts), from the built package. It is a
// committed file so pnpm can link it before the package is built.
import { main } from "../dist/tools/cli.js";

try {
  const said = await main(process.argv.slice(2));
  if (said) console.log(said);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
