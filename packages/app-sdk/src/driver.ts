import { assertDriverProblems } from "./device-problems.js";
import { registerPermission } from "./devices.js";
import { discoveredServices, isMalformedDiscover } from "./discovery.js";
import type { AppDefinition } from "./index.js";

/** Checks the driver's permission and the hooks its manifest declares. */
export function assertDriver(app: AppDefinition, asked: readonly string[]) {
  // A driver brings devices and carries out their commands, so the two go
  // together.
  const isDriver = asked.includes(registerPermission);
  if (isDriver !== (typeof app.driver?.command === "function")) {
    throw new Error(
      `A driver app holds ${registerPermission} and has a driver.command function`,
    );
  }
  const pairing = app.driver?.pairing;
  if (
    pairing !== undefined &&
    (typeof pairing?.open !== "function" ||
      typeof pairing?.close !== "function")
  ) {
    throw new Error("A driver's pairing has open and close functions");
  }
  for (const hook of ["move", "remove"] as const) {
    if (
      app.driver?.[hook] !== undefined &&
      typeof app.driver[hook] !== "function"
    ) {
      throw new Error(`A driver's ${hook} must be a function`);
    }
  }
  const firmware = app.driver?.firmware;
  if (
    firmware !== undefined &&
    (["check", "update", "stop"] as const).some(
      (hook) => typeof firmware?.[hook] !== "function",
    )
  ) {
    throw new Error("A driver's firmware has check, update and stop functions");
  }
  if (
    app.driver?.probe !== undefined &&
    typeof app.driver.probe !== "function"
  ) {
    throw new Error("A driver's probe must be a function");
  }
  if (app.driver) assertDriverProblems(app.driver);
  // A driver hears of what it looks for on the network; only it looks.
  const malformed = asked.find(isMalformedDiscover);
  if (malformed) {
    throw new Error(
      `${malformed} must name an mDNS service, such as discover:mdns:_example._tcp`,
    );
  }
  const looks = discoveredServices(asked).length > 0;
  if (looks && !isDriver) {
    throw new Error("Only a driver can ask for a discover:mdns: permission");
  }
  if (
    app.driver?.discovered !== undefined &&
    typeof app.driver.discovered !== "function"
  ) {
    throw new Error("A driver's discovered must be a function");
  }
  if (looks !== (app.driver?.discovered !== undefined)) {
    throw new Error(
      "A driver has a discovered function exactly when it asks for a discover:mdns: permission",
    );
  }
}
