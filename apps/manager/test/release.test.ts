import { describe, expect, it } from "vitest";

import {
  initialCoreImage,
  ReleaseError,
  resolveRelease,
} from "../src/release.js";

const host = {
  devRegistry: "localhost:5000",
  imageOwner: "meetsanctum",
  version: "dev-1a2b3c4",
};

describe("resolveRelease", () => {
  it("updates a dev host to a build in its own registry", () => {
    expect(resolveRelease({ ...host, channel: "dev" }, "dev-5e6f7a8")).toEqual({
      version: "dev-5e6f7a8",
      images: {
        core: "localhost:5000/sanctum-core:dev-5e6f7a8",
        manager: "localhost:5000/sanctum-manager:dev-5e6f7a8",
      },
    });
  });

  it("takes only dev builds on a dev host", () => {
    for (const version of [undefined, "1.2.3", "edge", "dev-", "dev-A/../x"]) {
      expect(() =>
        resolveRelease({ ...host, channel: "dev" }, version),
      ).toThrow(ReleaseError);
    }
  });

  it("keeps stable and edge hosts on their channel", () => {
    expect(resolveRelease({ ...host, channel: "stable" }).images).toEqual({
      core: "ghcr.io/meetsanctum/sanctum-core:stable",
      manager: "ghcr.io/meetsanctum/sanctum-manager:stable",
    });
    expect(resolveRelease({ ...host, channel: "edge" }, "edge").version).toBe(
      "edge",
    );
  });

  it("never applies a dev build to a household host", () => {
    expect(() =>
      resolveRelease({ ...host, channel: "stable" }, "dev-5e6f7a8"),
    ).toThrow("A stable host follows its channel and takes no version");
  });
});

describe("initialCoreImage", () => {
  it("starts a dev host with the core of the manager's own build", () => {
    expect(initialCoreImage({ ...host, channel: "dev" })).toBe(
      "localhost:5000/sanctum-core:dev-1a2b3c4",
    );
    expect(initialCoreImage({ ...host, channel: "edge" })).toBe(
      "ghcr.io/meetsanctum/sanctum-core:edge",
    );
  });
});
