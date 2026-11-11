import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  loadPackagedApp,
  manifestDigest,
  manifestFileName,
} from "./package.js";
import { appDatabaseName, coreSocketName } from "./protocol.js";
import { runSession } from "./runner-session.js";

// What an app's container runs: `node runner.js`, in the app's package, with
// its copy of this SDK. It hosts the app's code, opens its database and
// carries everything else to the core over a Unix socket. The manager says
// which app it is and where the socket's folder is
// (apps/manager/src/apps/containers.ts).

// A stop waits this long for the app's hook, inside the 10 seconds the manager
// gives a container before killing it.
const stopCapMs = 8_000;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const appId = process.env.SANCTUM_APP ?? fail("SANCTUM_APP is not set");
const sockets =
  process.env.SANCTUM_APP_SOCKETS ?? fail("SANCTUM_APP_SOCKETS is not set");
const packageDir = process.cwd();

const manifestFile = await readFile(join(packageDir, manifestFileName));
const manifest = z
  .object({ id: z.string(), version: z.string() })
  .parse(JSON.parse(manifestFile.toString("utf8")));
if (manifest.id !== appId) {
  fail(`This package holds ${manifest.id}, not ${appId}`);
}

const session = runSession({
  appId,
  socket: join(sockets, coreSocketName),
  database: join("/data", appDatabaseName),
  package: {
    version: manifest.version,
    manifest: manifestDigest(manifestFile),
    load: () => loadPackagedApp(packageDir),
  },
  log: console.error,
});

// As PID 1 it hears these only by asking, and a container told to stop would
// otherwise wait to be killed.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void session.shutdown(stopCapMs).then(() => process.exit(0));
  });
}

const { code, reason } = await session.finished;
if (code !== 0) {
  console.error(reason);
}
process.exit(code);
