import "reflect-metadata";

import * as x509 from "@peculiar/x509";
import { webcrypto } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";

import { readJson, writeJson } from "../state.js";

// The manager is the host's certificate authority. Its key stays in the
// manager's volume, readable only by the manager: never in a backup, over the
// socket or in a log. It signs only the core's certificates, for a key the core
// makes in memory, so any certificate that chains to it is this host's core.

x509.cryptoProvider.set(webcrypto as Crypto);

const ec = { name: "ECDSA", namedCurve: "P-256" } as const;
const signing = { name: "ECDSA", hash: "SHA-256" } as const;
const hourMs = 60 * 60_000;
const dayMs = 24 * hourMs;

export const caYears = 20;
export const coreCertificateDays = 90;

// Refused: the core sent something other than a P-256 public key.
export class InvalidPublicKey extends Error {}

type StoredCa = { certificate: string; key: string };

// Ends each PEM with a newline, so a chain is the certificates concatenated.
function pem(text: string) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

// A positive serial number of 16 random bytes.
function serialNumber() {
  const bytes = webcrypto.getRandomValues(new Uint8Array(16));
  bytes[0]! &= 0x7f;
  return Buffer.from(bytes).toString("hex");
}

// The CA's self-signed certificate, from a day before `now` for 20 years.
// Signing the same key again with other dates keeps the pin.
async function caCertificate(
  keys: webcrypto.CryptoKeyPair,
  name: string,
  now: Date,
) {
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + caYears);
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serialNumber(),
    name,
    notBefore: new Date(now.getTime() - dayMs),
    notAfter,
    keys,
    signingAlgorithm: signing,
    extensions: [
      // A CA that signs only end-entity certificates: path length 0.
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return pem(certificate.toString("pem"));
}

async function createCa(hostId: string, now: Date) {
  const keys = (await webcrypto.subtle.generateKey(ec, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  // Made before anyone claims or names the home, so it carries no home's name.
  const name = `CN=Sanctum Host CA ${hostId.slice(0, 8)}, O=Sanctum`;
  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  return {
    certificate: await caCertificate(keys, name, now),
    key: pem(x509.PemConverter.encode(pkcs8, "PRIVATE KEY")),
  };
}

async function importCa(stored: StoredCa) {
  const certificate = new x509.X509Certificate(stored.certificate);
  const key = await webcrypto.subtle.importKey(
    "pkcs8",
    x509.PemConverter.decode(stored.key)[0]!,
    ec,
    false,
    ["sign"],
  );
  // A key that does not match its certificate would sign certificates no
  // app accepts; better to stop than to make a new CA nobody pinned.
  const probe = new TextEncoder().encode("host CA");
  const signature = await webcrypto.subtle.sign(signing, key, probe);
  const publicKey = await certificate.publicKey.export(ec, ["verify"]);
  if (!(await webcrypto.subtle.verify(signing, publicKey, signature, probe))) {
    throw new Error("The host CA's key does not match its certificate");
  }
  return { certificate, pem: pem(stored.certificate), key, publicKey, stored };
}

// A CA certificate to sign again: not started yet, or ending within a year,
// by a synchronised clock.
function needsResigning(certificate: x509.X509Certificate, at: number) {
  return (
    at < certificate.notBefore.getTime() ||
    certificate.notAfter.getTime() - at < 365 * dayMs
  );
}

async function importCoreKey(publicKey: string) {
  try {
    const der = x509.PemConverter.decode(publicKey);
    if (der.length !== 1) {
      throw new InvalidPublicKey("Expected one public key");
    }
    return await webcrypto.subtle.importKey("spki", der[0]!, ec, true, [
      "verify",
    ]);
  } catch {
    throw new InvalidPublicKey("Not a P-256 public key");
  }
}

// The names the core's certificate carries, for tools and browsers: the
// host's mDNS hostname and its current addresses. The apps check the CA's
// pin, never names.
export type CertificateNames = { dns: string[]; ips: string[] };

// Link-local addresses (169.254.0.0/16, fe80::/10) mean nothing to anyone
// else on the network.
function isLinkLocal(address: string) {
  return address.startsWith("169.254.") || /^fe[89ab][0-9a-f]:/i.test(address);
}

// The manager runs on the host's network, so these are the host's own. The
// loopback names let the manager's health check verify the core by name. A
// certificate carries the addresses of the moment it was signed.
export function hostNames(): CertificateNames {
  const name = hostname().split(".")[0];
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((address) => address !== undefined)
    .filter((address) => !address.internal && !isLinkLocal(address.address))
    .map((address) => address.address);
  return {
    dns: [...(name ? [`${name}.local`] : []), "localhost"],
    ips: [...new Set([...ips, "127.0.0.1", "::1"])],
  };
}

export type IssuedCertificate = {
  // The core's certificate, then the CA's: the chain the core serves.
  certificate: string;
  ca: string;
  notAfter: string;
};

export async function createHostAuthority(options: {
  dataDir: string;
  hostId: string;
  names: () => CertificateNames;
  log: (message: string) => void;
  now?: () => Date;
  // Whether the clock is synchronised, or null where that can't be known
  // (clock.ts).
  clock?: () => Promise<boolean | null>;
  // How long the core's certificates last; shorter only to watch renewals.
  certificateDays?: number;
}) {
  const { log } = options;
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? (async () => null);
  const certificateDays = options.certificateDays ?? coreCertificateDays;
  const path = join(options.dataDir, "host-ca.json");
  const signingPath = join(options.dataDir, "signing.json");

  async function create() {
    const stored = await createCa(options.hostId, now());
    // Only the manager reads it (0600), like the rest of its volume.
    await writeJson(path, stored, { mode: 0o600 });
    log("Created a new host CA");
    return importCa(stored);
  }

  const existing = await readJson<StoredCa>(path);
  let ca = existing ? await importCa(existing) : await create();
  let lastSignedAt =
    Date.parse(
      (await readJson<{ lastSignedAt?: string }>(signingPath))?.lastSignedAt ??
        "",
    ) || 0;

  // When to date a certificate from. A synchronised clock is right, even
  // after an earlier signing ran ahead of it. Otherwise it may have restarted
  // behind after a power cut without internet, so certificates are dated from
  // the later of the clock and the last signing time.
  async function signingTime() {
    const at = now().getTime();
    const synchronised = (await clock()) === true;
    const base = synchronised ? at : Math.max(at, lastSignedAt);
    if (base !== lastSignedAt) {
      await writeJson(signingPath, {
        lastSignedAt: new Date(base).toISOString(),
      });
      lastSignedAt = base;
    }
    return { at: base, synchronised };
  }

  // Signs the CA's key again with dates from a synchronised clock, when the
  // certificate was made by a clock that ran ahead, or is ending. The pin
  // stays; the apps adopt the new certificate from the chain.
  async function resign(at: number) {
    const stored = {
      certificate: await caCertificate(
        { privateKey: ca.key, publicKey: ca.publicKey },
        ca.certificate.subject,
        new Date(at),
      ),
      key: ca.stored.key,
    };
    await writeJson(path, stored, { mode: 0o600 });
    ca = await importCa(stored);
    log("Signed the host CA's certificate again, with the corrected clock");
  }

  return {
    // The CA certificate, which apps pin through its public key.
    certificate: () => ca.pem,

    // Signs the core's public key for `certificateDays`, starting an hour
    // back to absorb small clock differences. The manager chooses the names;
    // the core only supplies its key.
    async sign(publicKey: string): Promise<IssuedCertificate> {
      const key = await importCoreKey(publicKey);
      const { dns, ips } = options.names();
      const { at: issuedAt, synchronised } = await signingTime();
      if (synchronised && needsResigning(ca.certificate, issuedAt)) {
        await resign(issuedAt);
      }
      const notAfter = new Date(issuedAt + certificateDays * dayMs);
      const certificate = await x509.X509CertificateGenerator.create({
        serialNumber: serialNumber(),
        subject: `CN=${dns[0] ?? "localhost"}`,
        issuer: ca.certificate.subject,
        notBefore: new Date(issuedAt - hourMs),
        notAfter,
        publicKey: key,
        signingKey: ca.key,
        signingAlgorithm: signing,
        extensions: [
          new x509.BasicConstraintsExtension(false, undefined, true),
          new x509.KeyUsagesExtension(
            x509.KeyUsageFlags.digitalSignature,
            true,
          ),
          new x509.ExtendedKeyUsageExtension([
            x509.ExtendedKeyUsage.serverAuth,
          ]),
          new x509.SubjectAlternativeNameExtension([
            ...dns.map((value) => ({ type: "dns" as const, value })),
            ...ips.map((value) => ({ type: "ip" as const, value })),
          ]),
          await x509.AuthorityKeyIdentifierExtension.create(
            ca.certificate,
            false,
          ),
          await x509.SubjectKeyIdentifierExtension.create(key),
        ],
      });
      log(`Signed the core's certificate until ${notAfter.toISOString()}`);
      return {
        certificate: pem(certificate.toString("pem")),
        ca: ca.pem,
        notAfter: notAfter.toISOString(),
      };
    },

    // A reset of the host makes a new CA: every app that pinned the old one
    // checks the host again, as after a restore onto new hardware.
    async replace() {
      ca = await create();
    },
  };
}

export type HostAuthority = Awaited<ReturnType<typeof createHostAuthority>>;
