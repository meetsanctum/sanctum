#!/usr/bin/env node
// The `sanctum-app` command (src/cli.ts), from the built package. It is a
// committed file so pnpm can link it before the package is built.
import { main } from "../dist/cli.js";

try {
  console.log(await main(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
