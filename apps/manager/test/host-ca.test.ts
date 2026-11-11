import {
  createHash,
  generateKeyPairSync,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  hostNames,
  createHostAuthority,
  type HostAuthority,
} from "../src/certificates/host-ca.js";
import { isSynchronised } from "../src/certificates/clock.js";
import { coreFetch } from "../src/certificates/core-fetch.js";
import { createClaimedReports } from "../src/claimed.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const hostId = "6b0f6f4e-2a52-4f8e-9a51-1d1d1f6e6e73";
const names = () => ({
  dns: ["sanctum-dev.local", "localhost"],
  ips: ["192.168.1.20", "127.0.0.1", "::1"],
});
const dayMs = 24 * 60 * 60_000;
const at = new Date("2026-10-28T12:00:00Z");

async function authority(dataDir?: string) {
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), "sanctum-ca-")));
  const logs: string[] = [];
  const created = await createHostAuthority({
    dataDir: dir,
    hostId,
    names,
    log: (message) => logs.push(message),
    now: () => at,
  });
  return { authority: created, dir, logs };
}

function coreKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }) as string,
    privateKey,
  };
}

function pinOf(certificate: string) {
  return createHash("sha256")
    .update(
      new X509Certificate(certificate).publicKey.export({
        type: "spki",
        format: "der",
      }),
    )
    .digest("base64url");
}

describe("the host CA", () => {
  it("is a P-256 CA of path length 0 for 20 years, kept only by the manager", async () => {
    const { authority: ca, dir, logs } = await authority();
    const certificate = new X509Certificate(ca.certificate());

    expect(certificate.ca).toBe(true);
    expect(certificate.publicKey.asymmetricKeyDetails).toEqual({
      namedCurve: "prime256v1",
    });
    expect(certificate.checkIssued(certificate)).toBe(true);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(new Date(certificate.validFrom).getTime()).toBe(
      at.getTime() - dayMs,
    );
    expect(new Date(certificate.validTo).getUTCFullYear()).toBe(2046);
    // Path length 0: it signs end-entity certificates only.
    const { BasicConstraintsExtension, X509Certificate: Parsed } =
      await import("@peculiar/x509");
    const constraints = new Parsed(ca.certificate()).getExtension(
      BasicConstraintsExtension,
    );
    expect(constraints).toMatchObject({ ca: true, pathLength: 0 });

    const file = join(dir, "host-ca.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(logs.join("\n")).not.toMatch(/PRIVATE KEY/);
  });

  it("is the same CA after a restart", async () => {
    const first = await authority();
    const second = await authority(first.dir);
    expect(second.authority.certificate()).toBe(first.authority.certificate());
    expect(second.logs).toEqual([]);
  });

  it("refuses a key that does not match its certificate", async () => {
    const first = await authority();
    const other = await authority();
    const file = join(first.dir, "host-ca.json");
    const stored = JSON.parse(await readFile(file, "utf8")) as object;
    const otherKey = (
      JSON.parse(await readFile(join(other.dir, "host-ca.json"), "utf8")) as {
        key: string;
      }
    ).key;
    await writeFile(file, JSON.stringify({ ...stored, key: otherKey }));
    await expect(authority(first.dir)).rejects.toThrow(/does not match/);
  });

  it("is named for the host's id", async () => {
    const { authority: ca } = await authority();
    expect(new X509Certificate(ca.certificate()).subject).toBe(
      "CN=Sanctum Host CA 6b0f6f4e\nO=Sanctum",
    );
  });

  it("is replaced by a reset", async () => {
    const { authority: ca, dir } = await authority();
    const before = ca.certificate();
    await ca.replace();
    expect(pinOf(ca.certificate())).not.toBe(pinOf(before));
    const restarted = await authority(dir);
    expect(restarted.authority.certificate()).toBe(ca.certificate());
  });
});

describe("the core's certificate", () => {
  it("is signed by the CA for 90 days, an hour back, for the names the manager chose", async () => {
    const { authority: ca } = await authority();
    const { publicKey } = coreKey();
    const issued = await ca.sign(publicKey);
    const certificate = new X509Certificate(issued.certificate);
    const caCertificate = new X509Certificate(issued.ca);

    expect(issued.ca).toBe(ca.certificate());
    expect(certificate.ca).toBe(false);
    expect(certificate.checkIssued(caCertificate)).toBe(true);
    expect(certificate.verify(caCertificate.publicKey)).toBe(true);
    expect(certificate.publicKey.export({ type: "spki", format: "pem" })).toBe(
      publicKey,
    );
    expect(new Date(certificate.validFrom).getTime()).toBe(
      at.getTime() - 60 * 60_000,
    );
    expect(new Date(certificate.validTo).getTime()).toBe(
      at.getTime() + 90 * dayMs,
    );
    expect(issued.notAfter).toBe(new Date(certificate.validTo).toISOString());
    expect(certificate.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    expect(certificate.subjectAltName).toBe(
      "DNS:sanctum-dev.local, DNS:localhost, IP Address:192.168.1.20, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1",
    );
  });

  it.each([
    "",
    "not a key",
    generateKeyPairSync("rsa", { modulusLength: 2048 })
      .publicKey.export({ type: "spki", format: "pem" })
      .toString(),
    generateKeyPairSync("ec", { namedCurve: "P-384" })
      .publicKey.export({ type: "spki", format: "pem" })
      .toString(),
  ])("is refused for a key that is not P-256: %#", async (publicKey) => {
    const { authority: ca } = await authority();
    const server = createServer({ version: "dev" }, { authority: ca });
    const response = await server.inject({
      method: "POST",
      url: "/api/certificate",
      payload: { publicKey },
    });
    expect(response.statusCode).toBe(400);
  });

  it("comes over the socket's API, with the CA certificate", async () => {
    const { authority: ca } = await authority();
    const server = createServer({ version: "dev" }, { authority: ca });
    const signed = await server.inject({
      method: "POST",
      url: "/api/certificate",
      payload: { publicKey: coreKey().publicKey },
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json()).toMatchObject({ ca: ca.certificate() });
    expect(signed.body).not.toMatch(/PRIVATE KEY/);

    const caOnly = await server.inject({ url: "/api/certificate/ca" });
    expect(caOnly.json()).toEqual({ certificate: ca.certificate() });
  });

  it("has the host's loopback names among its own", () => {
    const { dns, ips } = hostNames();
    expect(dns).toContain("localhost");
    expect(dns[0]).toMatch(/\.local$|^localhost$/);
    expect(ips).toEqual(expect.arrayContaining(["127.0.0.1", "::1"]));
    expect(ips.some((ip) => /^fe80:/i.test(ip))).toBe(false);
  });
});

describe("a reset", () => {
  it("makes a new CA when a claimed host comes back unclaimed, before saving", async () => {
    const events: string[] = [];
    let claimed: boolean | undefined;
    const report = createClaimedReports({
      wasClaimed: () => claimed,
      save: async (value) => {
        events.push(`save ${value.claimed}`);
        claimed = value.claimed;
      },
      replaceCa: async () => void events.push("new CA"),
      announce: (value) => events.push(`announce ${value.claimed}`),
    });

    await report({ claimed: false, homeId: "h0me-id-1" });
    await report({ claimed: true, homeId: "h0me-id-1" });
    await report({ claimed: true, homeId: "h0me-id-1" });
    await report({ claimed: false, homeId: "h0me-id-1" });
    await report({ claimed: false, homeId: "h0me-id-1" });

    expect(events).toEqual([
      "save false",
      "announce false",
      "save true",
      "announce true",
      "save true",
      "announce true",
      "new CA",
      "save false",
      "announce false",
      "save false",
      "announce false",
    ]);
  });

  it("keeps the claimed flag when the new CA could not be made", async () => {
    let claimed: boolean | undefined = true;
    let fail = true;
    const report = createClaimedReports({
      wasClaimed: () => claimed,
      save: async (value) => void (claimed = value.claimed),
      replaceCa: async () => {
        if (fail) throw new Error("disk full");
      },
      announce: () => undefined,
    });
    await expect(
      report({ claimed: false, homeId: "h0me-id-1" }),
    ).rejects.toThrow("disk full");
    expect(claimed).toBe(true);
    fail = false;
    await report({ claimed: false, homeId: "h0me-id-1" });
    expect(claimed).toBe(false);
  });
});

describe("the manager's health check of the core", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  async function serve(ca: HostAuthority, key = coreKey()) {
    const issued = await ca.sign(key.publicKey);
    const server = createHttpsServer(
      {
        key: (key.privateKey as KeyObject).export({
          type: "pkcs8",
          format: "pem",
        }),
        cert: issued.certificate + issued.ca,
      },
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
      },
    );
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as { port: number };
    return `https://127.0.0.1:${port}/api/health`;
  }

  it("trusts the host CA", async () => {
    const { authority: ca } = await createHostAuthorityNow();
    const url = await serve(ca);
    const response = await coreFetch(ca.certificate)(url);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("trusts nothing else", async () => {
    const { authority: ca } = await createHostAuthorityNow();
    const { authority: other } = await createHostAuthorityNow();
    const url = await serve(other);
    await expect(coreFetch(ca.certificate)(url)).rejects.toThrow(TypeError);
  });
});

// A CA dated by the real clock, for a TLS handshake that checks dates.
async function createHostAuthorityNow() {
  const dir = await mkdtemp(join(tmpdir(), "sanctum-ca-"));
  return {
    authority: await createHostAuthority({
      dataDir: dir,
      hostId,
      names,
      log: () => undefined,
    }),
  };
}

describe("the clock", () => {
  it("is synchronised while the kernel's maximum error is under 16 seconds", () => {
    expect(isSynchronised("    maxerror:     351500\n")).toBe(true);
    expect(isSynchronised("    maxerror:     16000000\n")).toBe(false);
    expect(isSynchronised("no such applet")).toBeNull();
  });

  it("is reported over the socket", async () => {
    const server = createServer(
      { version: "dev" },
      { clock: async () => false },
    );
    const response = await server.inject({ url: "/api/clock" });
    expect(response.json()).toEqual({ synchronised: false });
  });
});

describe("dating certificates by the clock", () => {
  async function authorityAt(
    clock: { now: number; synchronised: boolean | null },
    dir?: string,
  ) {
    const dataDir = dir ?? (await mkdtemp(join(tmpdir(), "sanctum-ca-")));
    const authority = await createHostAuthority({
      dataDir,
      hostId,
      names,
      log: () => undefined,
      now: () => new Date(clock.now),
      clock: async () => clock.synchronised,
    });
    return { authority, dataDir };
  }
  const leafOf = async (ca: HostAuthority) =>
    new X509Certificate((await ca.sign(coreKey().publicKey)).certificate);

  it("never goes back while the clock isn't synchronised", async () => {
    const real = Date.parse("2026-10-28T12:00:00Z");
    const clock = { now: real, synchronised: false as boolean | null };
    const { authority: ca, dataDir } = await authorityAt(clock);
    await leafOf(ca);

    // A power cut, and the clock restarts a year behind.
    clock.now = real - 365 * dayMs;
    const restarted = await authorityAt(clock, dataDir);
    const leaf = await leafOf(restarted.authority);
    expect(new Date(leaf.validFrom).getTime()).toBe(real - 60 * 60_000);
    expect(new Date(leaf.validTo).getTime()).toBe(real + 90 * dayMs);
  });

  it("follows a synchronised clock back from a signing that ran ahead", async () => {
    const real = Date.parse("2026-10-28T12:00:00Z");
    const clock = { now: real + 30 * dayMs, synchronised: null };
    const { authority: ca, dataDir } = await authorityAt(clock);
    await leafOf(ca);

    clock.now = real;
    (clock as { synchronised: boolean | null }).synchronised = true;
    const leaf = await leafOf(ca);
    expect(new Date(leaf.validFrom).getTime()).toBe(real - 60 * 60_000);
    const saved = JSON.parse(
      await readFile(join(dataDir, "signing.json"), "utf8"),
    ) as { lastSignedAt: string };
    expect(saved.lastSignedAt).toBe(new Date(real).toISOString());
  });

  it("signs the CA's key again once a synchronised clock shows its dates were wrong", async () => {
    const real = Date.parse("2026-10-28T12:00:00Z");
    // Made by a clock running a year ahead.
    const clock = {
      now: real + 365 * dayMs,
      synchronised: false as boolean | null,
    };
    const { authority: ca, dataDir } = await authorityAt(clock);
    const before = new X509Certificate(ca.certificate());
    expect(new Date(before.validFrom).getTime()).toBeGreaterThan(real);

    clock.now = real;
    clock.synchronised = true;
    const issued = await ca.sign(coreKey().publicKey);
    const after = new X509Certificate(issued.ca);

    expect(issued.ca).not.toBe(before.toString());
    expect(new Date(after.validFrom).getTime()).toBe(real - dayMs);
    expect(after.subject).toBe(before.subject);
    // The same key: the pin holds, and the leaf chains to the new certificate.
    expect(pinOf(issued.ca)).toBe(pinOf(before.toString()));
    expect(
      new X509Certificate(issued.certificate).verify(after.publicKey),
    ).toBe(true);
    // Kept for the next start.
    const restarted = await authorityAt(clock, dataDir);
    expect(restarted.authority.certificate()).toBe(issued.ca);
  });

  it("leaves a valid CA certificate alone, synchronised or not", async () => {
    const clock = {
      now: Date.parse("2026-10-28T12:00:00Z"),
      synchronised: true as boolean | null,
    };
    const { authority: ca } = await authorityAt(clock);
    const before = ca.certificate();
    await ca.sign(coreKey().publicKey);
    expect(ca.certificate()).toBe(before);
  });
});

describe("shorter certificates", () => {
  it("are only for a dev host, and never under about seven minutes", () => {
    expect(
      loadConfig({ SANCTUM_CHANNEL: "dev", MANAGER_CERTIFICATE_DAYS: "0.005" })
        .certificateDays,
    ).toBe(0.005);
    expect(() => loadConfig({ MANAGER_CERTIFICATE_DAYS: "1" })).toThrow(
      /dev host/,
    );
    expect(() =>
      loadConfig({ SANCTUM_CHANNEL: "dev", MANAGER_CERTIFICATE_DAYS: "0.001" }),
    ).toThrow();
  });
});
