import { loadApartPackages, shippedApps } from "./app-host/loader.js";
import { createCoreCertificates } from "./certificate.js";
import { loadConfig } from "./config.js";
import { openCoreDatabase } from "./database.js";
import { createManagerClient } from "./manager.js";
import { createModules } from "./modules.js";
import { loadHomeId } from "./places/places.js";
import { createServer, renewCertificate } from "./server.js";
import { watchUpdatePending } from "./update-pending.js";

const config = loadConfig();
const log = (message: string) => console.log(message);
// Migrates the core's database before anything serves. A core that cannot fails
// to start, so an update that brought it rolls back.
const database = openCoreDatabase(config.dataDir);
// The home this core serves, kept in its database.
const homeId = loadHomeId(database.db);
const updatePending = watchUpdatePending(config.dataDir);
const manager = createManagerClient({
  socketPath: config.managerSocket,
  homeId,
  log,
});
// Auth binds sign-ins to the host's id, which the manager keeps; until the
// manager answers, the routes that need it refuse with host_starting.
manager.learnHostId();
manager.followCapabilities();
// HTTPS with a certificate from the manager, except under `pnpm dev`.
const certificates = config.plainHttp
  ? undefined
  : createCoreCertificates({ sign: manager.signCertificate, log });

const modules = await createModules(database.db, {
  dataDir: config.dataDir,
  packagesDir: config.packagesDir,
  version: config.version,
  manager,
  hostId: manager.hostId,
  homeId,
  pin: () => certificates?.current()?.pin ?? null,
  // The manager announces the home's id and whether the host is claimed.
  onClaimed: () => void manager.reportClaimed(true),
  log,
});
const reported = manager.reportClaimed(modules.auth.isClaimed());
// And again now and then: a manager that started after the core, as when an
// update replaced it, has not heard the home's id yet.
const reportAgain = setInterval(
  () => void manager.reportClaimed(modules.auth.isClaimed()),
  5 * 60_000,
);

// The apps this core's image brings, each run apart from the package the manager
// staged for it. Each gets its database, asks for its services and starts; the
// core serves meanwhile, so a slow app cannot hold it up. Workflows start once
// they're all installed, so they find their pieces from the first tick. A core on
// trial runs no workflow or job and starts no app until the update commits, since a
// rollback can't undo what they did.
const onTrial = updatePending.isPending();
if (onTrial) modules.workflows.hold();
const shipped = await shippedApps(config.officialAppsDir, log);
const started = new Set<string>();
// What the manager has staged for this image, which it may still be doing, so the
// core doesn't wait for it to serve.
async function stagedPackages(only?: readonly string[]) {
  const staged = await manager.stagedApps();
  const apart = Object.entries(staged).flatMap(([id, { folder }]) =>
    !started.has(id) && (!only || only.includes(id)) ? [`${id}@${folder}`] : [],
  );
  const packages = await loadApartPackages(
    [...(only ? [] : config.appsApart), ...apart],
    config.packagesDir,
    log,
  );
  for (const pkg of packages) started.add(pkg.apart.manifest.id);
  return packages;
}
// Packages that can't be read mean a broken image. The core may be serving by then,
// but it ends all the same, so Docker tries it again and one on trial rolls back.
const first = stagedPackages();
void modules.apps
  .start(first, { onTrial, coming: shipped })
  .catch((error: unknown) => {
    log(`apps: didn't start (${String(error)})`);
    process.exit(1);
  });
// One the image ships that the manager hasn't staged, as an old manager or one
// whose staging failed, is asked for again now and then, one ask at a time, and
// starts once it's there. What it brought stays meanwhile.
let askAgain: NodeJS.Timeout | undefined;
let isAsking = false;
async function startStaged(missing: readonly string[]) {
  const packages = await stagedPackages(missing);
  if (packages.length === 0) return;
  await modules.apps.start(packages, {
    onTrial: updatePending.isPending(),
    coming: shipped,
  });
}
void first.then(
  () => {
    askAgain = setInterval(() => {
      const missing = shipped.filter((id) => !started.has(id));
      if (missing.length === 0) return clearInterval(askAgain);
      if (isAsking) return;
      isAsking = true;
      startStaged(missing)
        .catch((error: unknown) => log(`apps: didn't start (${String(error)})`))
        .finally(() => (isAsking = false));
    }, 60_000);
  },
  () => undefined,
);
updatePending.whenCommitted(() => {
  void modules.apps.committed().then(() => modules.workflows.start());
});
modules.history.start();
modules.activity.start(config.version);
modules.managerAudit?.start();

// A reset leaves the host unclaimed, and the manager then makes a new CA, so
// the core reports first and asks for its certificate after. Until the
// manager answers, the core waits and serves nothing.
if (certificates) {
  await reported;
}
const certificate = await certificates?.first();
const server = createServer(config, {
  ...modules,
  updatePending: updatePending.isPending,
  https: certificate && { key: certificate.key, cert: certificate.cert },
});
certificates?.watch((next) =>
  renewCertificate(server, { key: next.key, cert: next.cert }),
);

const shutdown = async () => {
  clearInterval(reportAgain);
  clearInterval(askAgain);
  certificates?.close();
  manager.close();
  updatePending.close();
  await server.close();
  modules.activity.stop();
  await modules.close();
  database.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.listen({ host: config.host, port: config.port });
log(
  `core ${config.version} listening on ${certificate ? "https" : "http"}://${config.host}:${config.port}${updatePending.isPending() ? ", waiting for the update to commit" : ""}`,
);
