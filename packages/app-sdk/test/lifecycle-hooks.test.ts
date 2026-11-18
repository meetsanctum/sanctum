import { describe, expect, it } from "vitest";

import { defineApp, type AppDefinition } from "../src/index.js";

const base = {
  id: "sanctum.example",
  name: "Example",
  version: "1.0.0",
  core: "^2.0.0",
  permissions: [],
  actions: [],
  events: [],
};

describe("an app's lifecycle hooks", () => {
  it.each(["start", "resume", "stop", "uninstall"] as const)(
    "requires %s to be a function when present",
    (hook) => {
      expect(() =>
        defineApp({ ...base, [hook]: "tidy" } as unknown as AppDefinition),
      ).toThrow(`An app's ${hook} must be a function`);
      expect(
        defineApp({ ...base, [hook]: async () => undefined }),
      ).toBeDefined();
    },
  );
});
