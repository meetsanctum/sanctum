import { loadApartPackages, loadAppPackages } from "./app-host/loader.js";
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

// The packages the core ships with, each with the origin of the folder it
// was found in, never one from the package: system apps first, so an
// official package cannot take a system app's id. Each gets its database,
// asks for its services and starts; the core serves meanwhile, so a slow app
// cannot hold it up. Workflows start once they're all installed, so they
// find their pieces from the first tick. A core on trial runs no workflow or
// job and starts no app that runs apart until the update commits, since a
// rollback can't undo what they did.
const onTrial = updatePending.isPending();
if (onTrial) modules.workflows.hold();
// The official apps that run apart come from what the manager staged for this image,
// which it may still be doing, so they're asked for without holding up the core.
async function packagesToStart() {
  const staged = await manager.stagedApps();
  const apart = config.officialAppsApart.flatMap((id) => {
    const package_ = staged[id];
    return package_ ? [`${id}@${package_.folder}`] : [];
  });
  return [
    ...(config.systemAppsDir
      ? await loadAppPackages(config.systemAppsDir, "system", log)
      : []),
    ...(await loadAppPackages(config.officialAppsDir, "official", log)),
    ...(await loadApartPackages(
      [...config.appsApart, ...apart],
      config.packagesDir,
      log,
    )),
  ];
}
// Packages that can't be read mean a broken image. The core may be serving by then,
// but it ends all the same, so Docker tries it again and one on trial rolls back.
void modules.apps
  .start(packagesToStart(), { onTrial })
  .catch((error: unknown) => {
    log(`apps: didn't start (${String(error)})`);
    process.exit(1);
  });
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
