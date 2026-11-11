import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";

// The name a new client gets, as people know this computer ("Maya's
// MacBook Air"). It can be renamed later.
export async function deviceName() {
  let name = "";
  if (process.platform === "darwin") {
    name = await promisify(execFile)("scutil", ["--get", "ComputerName"])
      .then(({ stdout }) => stdout.trim())
      .catch(() => "");
  }
  name ||= hostname().replace(/\.local$/, "");
  return name.slice(0, 60) || "Desktop";
}
