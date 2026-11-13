import {
  maxAppSecrets,
  maxSecretBytes,
  secretNamePattern,
} from "@meetsanctum/app-sdk";
import { and, count, eq } from "drizzle-orm";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { durably, type CoreDatabase } from "../database.js";
import { appSecrets } from "./schema.js";

// Apps' own secrets, such as their devices' keys. The core seals each with
// AES-256-GCM under a key of its own, kept beside core.db in its data folder,
// so a copy of core.db on its own holds none in the clear. Whoever has the
// whole data folder has both: the host's disk, root on the host, the manager,
// which mounts the folder to copy it before an update, and those copies,
// which stay on the host. A secret never reaches a client, the activity log
// or the core's own log, and stays as long as the app's database does:
// removing an app keeps both. A rollback of the core's data takes them back
// with it; an app going back to an older version leaves them, as a key on a
// device doesn't go back.

/** The file in the core's data folder holding the key secrets are sealed with. */
export const secretsKeyFile = "secrets.key";

const keyBytes = 32;
const nonceBytes = 12;
const tagBytes = 16;

export const secretName = z.string().regex(secretNamePattern);
export const secretValue = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value) <= maxSecretBytes,
    `A secret is at most ${maxSecretBytes} bytes`,
  );

// The key, made once and on the disk before anything is sealed with it.
function keyIn(dataDir: string) {
  const path = join(dataDir, secretsKeyFile);
  try {
    const key = readFileSync(path);
    if (key.length !== keyBytes) {
      throw new Error(`${path} is not a key of ${keyBytes} bytes`);
    }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = randomBytes(keyBytes);
  const partial = `${path}.partial`;
  rmSync(partial, { force: true });
  const file = openSync(partial, "wx", 0o600);
  try {
    writeSync(file, key);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(partial, path);
  const folder = openSync(dataDir, "r");
  try {
    fsyncSync(folder);
  } finally {
    closeSync(folder);
  }
  return key;
}

// What each secret is sealed with names its app and name, so a sealed value
// moved to another row doesn't open.
const boundTo = (appId: string, name: string) =>
  Buffer.from(`${appId}\0${name}`, "utf8");

export type AppSecrets = ReturnType<typeof createAppSecrets>;

export function createAppSecrets(
  db: CoreDatabase,
  options: {
    dataDir: string;
    log: (message: string) => void;
    now?: () => Date;
  },
) {
  const key = keyIn(options.dataDir);
  const now = options.now ?? (() => new Date());

  function seal(appId: string, name: string, value: string) {
    const nonce = randomBytes(nonceBytes);
    const cipher = createCipheriv("aes-256-gcm", key, nonce) as CipherGCM;
    cipher.setAAD(boundTo(appId, name));
    const sealed = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), sealed]).toString(
      "base64",
    );
  }

  function open(appId: string, name: string, sealed: string) {
    const bytes = Buffer.from(sealed, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      bytes.subarray(0, nonceBytes),
    ) as DecipherGCM;
    decipher.setAAD(boundTo(appId, name));
    decipher.setAuthTag(bytes.subarray(nonceBytes, nonceBytes + tagBytes));
    return Buffer.concat([
      decipher.update(bytes.subarray(nonceBytes + tagBytes)),
      decipher.final(),
    ]).toString("utf8");
  }

  const row = (appId: string, name: string) =>
    and(eq(appSecrets.appId, appId), eq(appSecrets.name, name));

  return {
    /**
     * The app's secret by its name, or null when it has none. One that
     * doesn't open, as when the key it was sealed with is gone, is as good
     * as none, and the log says so without its value.
     */
    get(appId: string, name: string): string | null {
      const found = db
        .select({ sealed: appSecrets.sealed })
        .from(appSecrets)
        .where(row(appId, name))
        .get();
      if (!found) return null;
      try {
        return open(appId, name, found.sealed);
      } catch {
        options.log(
          `apps: ${appId}'s secret ${name} doesn't open with this core's key`,
        );
        return null;
      }
    },

    /**
     * Keeps the app's secret, on the disk once it returns. An app keeps at
     * most 64; replacing one counts as keeping it.
     */
    put(appId: string, name: string, value: string) {
      const sealed = seal(appId, name, value);
      durably(db, () => {
        const kept = db
          .select({ name: appSecrets.name })
          .from(appSecrets)
          .where(row(appId, name))
          .get();
        if (!kept) {
          const kept = db
            .select({ total: count() })
            .from(appSecrets)
            .where(eq(appSecrets.appId, appId))
            .get();
          if ((kept?.total ?? 0) >= maxAppSecrets) {
            throw new Error(
              `${appId} keeps ${maxAppSecrets} secrets already, the most it may`,
            );
          }
        }
        db.insert(appSecrets)
          .values({ appId, name, sealed, updatedAt: now() })
          .onConflictDoUpdate({
            target: [appSecrets.appId, appSecrets.name],
            set: { sealed, updatedAt: now() },
          })
          .run();
      });
    },

    remove(appId: string, name: string) {
      durably(db, () => db.delete(appSecrets).where(row(appId, name)).run());
    },
  };
}
