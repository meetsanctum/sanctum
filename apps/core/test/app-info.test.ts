import {
  defineApp,
  toStaticManifest,
  type StaticManifest,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { appInfoOf } from "../src/app-host/app-info.js";

// An installed app as clients see it: the colours it names for the page the
// shell draws reach them only as colours, whatever its sanctum-app.json says.

const manifest = (backdrop: unknown) =>
  ({
    ...toStaticManifest(
      defineApp({
        id: "sanctum.example",
        name: "Example",
        version: "0.1.0",
        core: "^2.0.0",
        permissions: [],
        actions: [],
        events: [],
      }),
    ),
    backdrop,
  }) as StaticManifest;

const now = { granted: [], state: "running" as const, settings: null };

describe("an app's colours", () => {
  it("reach clients as the manifest names them", () => {
    const backdrop = { from: "#0A5C7A", to: "#18BCF2" };
    expect(appInfoOf(manifest(backdrop), now).backdrop).toEqual(backdrop);
  });

  it("are left out where the manifest names none", () => {
    expect(appInfoOf(manifest(null), now)).not.toHaveProperty("backdrop");
    expect(appInfoOf(manifest(undefined), now)).not.toHaveProperty("backdrop");
  });

  it("are left out where they aren't plain colours", () => {
    const backdrop = { from: "url(https://example.com/x)", to: "#18BCF2" };
    expect(appInfoOf(manifest(backdrop), now)).not.toHaveProperty("backdrop");
  });
});
