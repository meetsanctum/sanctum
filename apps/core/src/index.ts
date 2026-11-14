import { loadConfig } from "./config.js";
import { startCore } from "./core.js";

// The core as a host runs it (core.ts), stopped by the process's signals.
const core = await startCore(loadConfig(), {
  log: (message) => console.log(message),
  exit: (code) => process.exit(code),
});

const shutdown = async () => {
  await core.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await core.listen();
