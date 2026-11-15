import { loadConfig } from "./config.js";
import { createCore } from "./core.js";

// The core as a host runs it (core.ts): a signal stops it, and the process
// ends with its exit code once it has stopped, however it came to stop.
const core = createCore(loadConfig(), {
  log: (message) => console.log(message),
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void core.stop("signal"));
}
void core.start();
process.exit((await core.stopped).code);
