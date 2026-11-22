import "reflect-metadata";

import * as x509 from "@peculiar/x509";
import { webcrypto } from "node:crypto";

// Host CAs and core certificates for tests, as the manager makes them
// (apps/manager/src/certificates/host-ca.ts), with ways to get them wrong.

x509.cryptoProvider.set(webcrypto as Crypto);

const ec = { name: "ECDSA", namedCurve: "P-256" } as const;
const signing = { name: "ECDSA", hash: "SHA-256" } as const;
const dayMs = 24 * 60 * 60_000;
let serial = 1;

function next() {
  serial += 1;
  return serial.toString(16).padStart(4, "0");
}

export async function testCa(
  options: { notBefore?: number; notAfter?: number; ca?: boolean } = {},
  keys?: webcrypto.CryptoKeyPair,
) {
  const own =
    keys ??
    ((await webcrypto.subtle.generateKey(ec, true, [
      "sign",
      "verify",
    ])) as webcrypto.CryptoKeyPair);
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: next(),
    name: "CN=Test host CA",
    notBefore: new Date(options.notBefore ?? Date.now() - dayMs),
    notAfter: new Date(options.notAfter ?? Date.now() + 365 * dayMs),
    keys: own,
    signingAlgorithm: signing,
    extensions: [
      new x509.BasicConstraintsExtension(options.ca ?? true, 0, true),
    ],
  });

  return {
    keys: own,
    pem: `${certificate.toString("pem")}\n`,
    // The same key, re-signed with other dates.
    reissue: (dates: { notBefore?: number; notAfter?: number }) =>
      testCa(dates, own),
    async leaf(
      leafOptions: {
        notBefore?: number;
        notAfter?: number;
        serverAuth?: boolean;
        ca?: boolean;
      } = {},
    ) {
      const leafKeys = (await webcrypto.subtle.generateKey(ec, true, [
        "sign",
        "verify",
      ])) as webcrypto.CryptoKeyPair;
      const leaf = await x509.X509CertificateGenerator.create({
        serialNumber: next(),
        subject: "CN=localhost",
        issuer: certificate.subject,
        notBefore: new Date(leafOptions.notBefore ?? Date.now() - 60 * 60_000),
        notAfter: new Date(leafOptions.notAfter ?? Date.now() + 90 * dayMs),
        publicKey: leafKeys.publicKey,
        signingKey: own.privateKey,
        signingAlgorithm: signing,
        extensions: [
          new x509.BasicConstraintsExtension(
            leafOptions.ca ?? false,
            undefined,
            true,
          ),
          ...(leafOptions.serverAuth === false
            ? []
            : [
                new x509.ExtendedKeyUsageExtension([
                  x509.ExtendedKeyUsage.serverAuth,
                ]),
              ]),
        ],
      });
      return `${leaf.toString("pem")}\n`;
    },
  };
}

export type TestCa = Awaited<ReturnType<typeof testCa>>;
