import { describe, expect, it } from "vitest";

import {
  defineApp,
  toStaticManifest,
  type AppDefinition,
  type DevicePageDefinition,
} from "../src/index.js";

// A page an app adds to devices' detail: for the kinds it may read, or, for a
// driver, for the devices it brings alone, which an older client skips as a
// page for no kind.

function withPages(
  devicePages: DevicePageDefinition[],
  permissions: AppDefinition["permissions"] = [
    { id: "devices.register", reason: "For the test." },
  ],
) {
  return defineApp({
    id: "sanctum.example",
    name: "Example",
    version: "0.1.0",
    core: "^2.0.0",
    permissions,
    actions: [],
    events: [],
    provides: { devicePages },
    ...(permissions.some((each) => each.id === "devices.register")
      ? { driver: { command: async () => undefined } }
      : {}),
  });
}

describe("a driver's page on its own devices", () => {
  it("has no kinds in the manifest, so a client from before shows it nowhere", () => {
    const app = withPages([
      { id: "example.status", title: "Status", devices: "own" },
    ]);

    expect(toStaticManifest(app).provides.devicePages).toEqual([
      { id: "example.status", title: "Status", kinds: [], devices: "own" },
    ]);
  });

  it("is only a driver's, and either for its devices or for kinds", () => {
    expect(() =>
      withPages(
        [{ id: "example.status", title: "Status", devices: "own" }],
        [{ id: "devices.read:light", reason: "For the test." }],
      ),
    ).toThrow("only a driver does");
    expect(() =>
      withPages([
        {
          id: "example.status",
          title: "Status",
          devices: "own",
          kinds: ["light"],
        } as unknown as DevicePageDefinition,
      ]),
    ).toThrow('devices: "own"');
    expect(() =>
      withPages([
        {
          id: "example.status",
          title: "Status",
          devices: "everyone",
        } as unknown as DevicePageDefinition,
      ]),
    ).toThrow('devices: "own"');
  });
});
