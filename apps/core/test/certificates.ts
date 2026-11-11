import "reflect-metadata";

import * as x509 from "@peculiar/x509";
import { webcrypto } from "node:crypto";

import type { SignedCertificate } from "../src/certificate.js";

// A stand-in for the manager's host CA (apps/manager/src/certificates): it
// signs the core's public key for `lifetimeMs`, starting an hour back.

x509.cryptoProvider.set(webcrypto as Crypto);

const ec = { name: "ECDSA", namedCurve: "P-256" } as const;
const signing = { name: "ECDSA", hash: "SHA-256" } as const;

export async function testCa(
  options: { now?: () => number; lifetimeMs?: number } = {},
) {
  const now = options.now ?? Date.now;
  const keys = (await webcrypto.subtle.generateKey(ec, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=Test host CA",
    notBefore: new Date(now() - 24 * 60 * 60_000),
    notAfter: new Date(now() + 365 * 24 * 60 * 60_000),
    keys,
    signingAlgorithm: signing,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true),
    ],
  });
  let serial = 1;
  const requests: string[] = [];

  return {
    certificate: ca.toString("pem"),
    requests,
    async sign(publicKey: string): Promise<SignedCertificate> {
      requests.push(publicKey);
      serial += 1;
      const issuedAt = now();
      const certificate = await x509.X509CertificateGenerator.create({
        serialNumber: serial.toString(16).padStart(2, "0"),
        subject: "CN=localhost",
        issuer: ca.subject,
        notBefore: new Date(issuedAt - 60 * 60_000),
        notAfter: new Date(issuedAt + (options.lifetimeMs ?? 90 * 86_400_000)),
        publicKey: await webcrypto.subtle.importKey(
          "spki",
          x509.PemConverter.decode(publicKey)[0]!,
          ec,
          true,
          ["verify"],
        ),
        signingKey: keys.privateKey,
        signingAlgorithm: signing,
        extensions: [
          new x509.BasicConstraintsExtension(false, undefined, true),
          new x509.ExtendedKeyUsageExtension([
            x509.ExtendedKeyUsage.serverAuth,
          ]),
          new x509.SubjectAlternativeNameExtension([
            { type: "dns", value: "localhost" },
            { type: "ip", value: "127.0.0.1" },
          ]),
        ],
      });
      return {
        certificate: `${certificate.toString("pem")}\n`,
        ca: `${ca.toString("pem")}\n`,
      };
    },
  };
}
