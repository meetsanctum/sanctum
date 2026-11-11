import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { isPin } from "@meetsanctum/auth-protocol";

import type { KeptHost } from "./shell.js";

// The paired host and its client token, in the app's data folder, encrypted
// with the system's secure storage, with the host CA's pin and certificate.
// Where the system has none, the client warned before signing in, and the
// file is plain.

export type Cipher = {
  isSecure(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
};

// Electron's safeStorage. On Linux without a keyring it falls back to a
// hard-coded key, which is no secure storage at all.
export function safeStorageCipher(safeStorage: {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
}): Cipher {
  return {
    isSecure: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" ||
        safeStorage.getSelectedStorageBackend?.() !== "basic_text"),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  };
}

type StoredFile = { version: 1; encrypted: boolean; data: string };

// A host over HTTPS has its pin and CA certificate. Plain HTTP, without
// either, is only for development, and a packaged app never keeps one.
function isKeptHost(
  value: unknown,
  allowPlainHttp: boolean,
): value is KeptHost {
  const host = value as Partial<KeptHost> | null;
  if (
    typeof host !== "object" ||
    host === null ||
    !(["hostId", "name", "url", "clientId", "token"] as const).every(
      (key) => typeof host[key] === "string",
    ) ||
    typeof host.homeId !== "string" ||
    (host.kind !== "personal" && host.kind !== "shared")
  ) {
    return false;
  }
  if (host.url!.startsWith("https://")) {
    return isPin(host.pin) && typeof host.caCertificate === "string";
  }
  return (
    allowPlainHttp &&
    host.url!.startsWith("http://") &&
    host.pin === null &&
    host.caCertificate === null
  );
}

export function createCredentialStore(
  path: string,
  cipher: Cipher,
  options: { allowPlainHttp?: boolean } = {},
) {
  const allowPlainHttp = options.allowPlainHttp ?? false;
  // IPC calls may overlap. Keep the read/check/delete in forget atomic with
  // saves, and let reads see every write requested before them.
  let pending: Promise<unknown> = Promise.resolve();
  function ordered<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
  }

  // What a file holds, decrypted; none when it is missing or unreadable.
  async function read(file: string): Promise<unknown> {
    let stored: StoredFile;
    try {
      stored = JSON.parse(await readFile(file, "utf8")) as StoredFile;
    } catch {
      return undefined;
    }
    try {
      const data = Buffer.from(stored.data, "base64");
      return JSON.parse(
        stored.encrypted ? cipher.decrypt(data) : data.toString("utf8"),
      ) as unknown;
    } catch {
      return undefined;
    }
  }

  async function load(): Promise<KeptHost | null> {
    const host = await read(path);
    return isKeptHost(host, allowPlainHttp) ? host : null;
  }

  async function write(host: KeptHost) {
    if (!isKeptHost(host, allowPlainHttp)) {
      throw new TypeError("Not a host to store");
    }
    const text = JSON.stringify(host);
    const encrypted = cipher.isSecure();
    const file: StoredFile = {
      version: 1,
      encrypted,
      data: (encrypted
        ? cipher.encrypt(text)
        : Buffer.from(text, "utf8")
      ).toString("base64"),
    };
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(file), { mode: 0o600 });
    await rename(temporary, path);
  }

  return {
    isSecure: () => cipher.isSecure(),

    load: () => ordered(load),

    save(host: KeptHost) {
      return ordered(() => write(host));
    },

    // Keeps a CA certificate the host re-signed with the same key, once a
    // connection checked it, if that pin is still held.
    replaceCaCertificate(pin: string, caCertificate: string) {
      return ordered(async () => {
        const host = await load();
        if (host?.pin === pin && host.caCertificate !== caCertificate) {
          await write({ ...host, caCertificate });
        }
      });
    },

    // Forgets the host only if it still holds `token`, so a late answer about
    // an old token never signs out a newer sign-in.
    forget(token: string) {
      return ordered(async () => {
        if ((await load())?.token === token) {
          await rm(path, { force: true });
        }
      });
    },
  };
}
