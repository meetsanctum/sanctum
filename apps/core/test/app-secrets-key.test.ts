import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createAppSecrets, secretsKeyFile } from "../src/app-host/secrets.js";
import { openCoreDatabase } from "../src/database.js";

// Another core started on the same data puts its key in place between this
// core finding none and linking its own.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    linkSync(from: string, to: string) {
      if (to.endsWith("secrets.key")) {
        fs.writeFileSync(to, Buffer.alloc(32, 9), { mode: 0o600 });
      }
      fs.linkSync(from, to);
    },
  };
});

describe("the core's secrets key", () => {
  it("is the one another core put in place first, with nothing left over", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sanctum-secrets-"));
    const database = openCoreDatabase(dataDir);
    try {
      const secrets = createAppSecrets(database.db, { dataDir, log() {} });
      secrets.put("test.keeper", "device", "a device's key");

      expect(await readFile(join(dataDir, secretsKeyFile))).toEqual(
        Buffer.alloc(32, 9),
      );
      expect(await readdir(dataDir)).not.toContainEqual(
        expect.stringMatching(/\.partial$/),
      );
      const again = createAppSecrets(database.db, { dataDir, log() {} });
      expect(again.get("test.keeper", "device")).toBe("a device's key");
    } finally {
      database.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
