import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createCredentialStore, type Cipher } from "../src/credentials.js";
import type { KeptHost } from "../src/shell.js";

const pin = "hg6mmQxxksnFQb7m8qDqK0hT9z6lRb6vS8aW2b0FbUQ";
const host: KeptHost = {
  hostId: "6b0f6f4e-2a52-4f8e-9a51-1d1d1f6e6e73",
  homeId: "0d5c1f0a-7a43-4b6e-8f0e-2f6a0c9b1e55",
  name: "Sanctum",
  url: "https://192.168.1.20:4100",
  clientId: "c1",
  token: "client_secret",
  kind: "personal",
  pin,
  caCertificate: "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----\n",
};

// Stands in for safeStorage: reverses the bytes.
function cipher(secure: boolean): Cipher {
  return {
    isSecure: () => secure,
    encrypt: (text) => Buffer.from(text, "utf8").reverse(),
    decrypt: (data) => Buffer.from(data).reverse().toString("utf8"),
  };
}

async function store(secure = true, allowPlainHttp = false) {
  const path = join(
    await mkdtemp(join(tmpdir(), "sanctum-desktop-")),
    "host.json",
  );
  return {
    path,
    credentials: createCredentialStore(path, cipher(secure), {
      allowPlainHttp,
    }),
  };
}

describe("the stored host", () => {
  it("is encrypted, readable only by this user, and loaded back", async () => {
    const { path, credentials } = await store();

    await credentials.save(host);

    const file = await readFile(path, "utf8");
    expect(file).not.toContain(host.token);
    expect(JSON.parse(file)).toMatchObject({ version: 1, encrypted: true });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await credentials.load()).toEqual(host);
  });

  it("is kept plain where the system has no secure storage", async () => {
    const { path, credentials } = await store(false);

    await credentials.save(host);

    expect(credentials.isSecure()).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      encrypted: false,
    });
    expect(await credentials.load()).toEqual(host);
  });

  it("is forgotten only for the token it holds", async () => {
    const { credentials } = await store();
    await credentials.save(host);

    await credentials.forget("client_older");
    expect(await credentials.load()).toEqual(host);

    await credentials.forget(host.token);
    expect(await credentials.load()).toBeNull();
  });

  it("is nothing when missing or unreadable", async () => {
    const { credentials } = await store();
    expect(await credentials.load()).toBeNull();

    await expect(
      credentials.save({ ...host, url: "file:///etc/passwd" }),
    ).rejects.toThrow(TypeError);
  });

  it("keeps a host over HTTPS only with its pin and CA certificate", async () => {
    const { credentials } = await store();
    for (const broken of [
      { ...host, pin: null },
      { ...host, pin: "not-a-pin" },
      { ...host, caCertificate: null },
      { ...host, kind: "admin" as "personal" },
    ]) {
      await expect(credentials.save(broken)).rejects.toThrow(TypeError);
    }
  });

  it("keeps a host over plain HTTP only in development", async () => {
    const plain = {
      ...host,
      url: "http://127.0.0.1:4100",
      pin: null,
      caCertificate: null,
    };
    const packaged = await store();
    await expect(packaged.credentials.save(plain)).rejects.toThrow(TypeError);
    const development = await store(true, true);
    await development.credentials.save(plain);
    expect(await development.credentials.load()).toEqual(plain);
    // A packaged app does not load one a development build saved.
    const reopened = createCredentialStore(development.path, cipher(true));
    expect(await reopened.load()).toBeNull();
  });

  it("replaces the CA certificate only while its pin is held", async () => {
    const { credentials } = await store();
    await credentials.save(host);

    await credentials.replaceCaCertificate("another-pin", "other");
    expect((await credentials.load())?.caCertificate).toBe(host.caCertificate);
    await credentials.replaceCaCertificate(pin, "reissued");
    expect(await credentials.load()).toEqual({
      ...host,
      caCertificate: "reissued",
    });
  });

  it("forgets a token even while its save is still in progress", async () => {
    const { credentials } = await store();

    const saving = credentials.save(host);
    const forgetting = credentials.forget(host.token);
    await Promise.all([saving, forgetting]);

    expect(await credentials.load()).toBeNull();
  });

  it("keeps a newer sign-in when an older token is forgotten concurrently", async () => {
    const { credentials } = await store();
    await credentials.save(host);
    const newer = { ...host, token: "client_newer" };

    await Promise.all([
      credentials.save(newer),
      credentials.forget(host.token),
    ]);

    expect(await credentials.load()).toEqual(newer);
  });
});
