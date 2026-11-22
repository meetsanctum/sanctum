import "reflect-metadata";

import { spkiPin } from "@meetsanctum/auth-protocol";
import * as x509 from "@peculiar/x509";
import { webcrypto } from "node:crypto";

// A host CA and a server certificate it signed, as a home serves them, for
// a test server to present.

x509.cryptoProvider.set(webcrypto as Crypto);

const ec = { name: "ECDSA", namedCurve: "P-256" } as const;
const signing = { name: "ECDSA", hash: "SHA-256" } as const;
const dayMs = 24 * 60 * 60_000;
let serial = 1;

const next = () => (serial += 1).toString(16).padStart(4, "0");

async function keyPair() {
  return (await webcrypto.subtle.generateKey(ec, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
}

export async function testCa() {
  const keys = await keyPair();
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: next(),
    name: "CN=Test host CA",
    notBefore: new Date(Date.now() - dayMs),
    notAfter: new Date(Date.now() + 365 * dayMs),
    keys,
    signingAlgorithm: signing,
    extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
  });
  const pem = `${ca.toString("pem")}\n`;
  const pin = await spkiPin(
    new Uint8Array(await webcrypto.subtle.exportKey("spki", keys.publicKey)),
  );

  return {
    pem,
    pin,
    /** A server certificate this CA signed, with its key, chain first. */
    async serving() {
      const leafKeys = await keyPair();
      const leaf = await x509.X509CertificateGenerator.create({
        serialNumber: next(),
        subject: "CN=sanctum",
        issuer: ca.subject,
        notBefore: new Date(Date.now() - 60 * 60_000),
        notAfter: new Date(Date.now() + 90 * dayMs),
        publicKey: leafKeys.publicKey,
        signingKey: keys.privateKey,
        signingAlgorithm: signing,
        extensions: [
          new x509.BasicConstraintsExtension(false, undefined, true),
          new x509.ExtendedKeyUsageExtension([
            x509.ExtendedKeyUsage.serverAuth,
          ]),
        ],
      });
      const der = Buffer.from(
        await webcrypto.subtle.exportKey("pkcs8", leafKeys.privateKey),
      );
      const key = `-----BEGIN PRIVATE KEY-----\n${der
        .toString("base64")
        .match(/.{1,64}/g)!
        .join("\n")}\n-----END PRIVATE KEY-----\n`;
      return { key, cert: `${leaf.toString("pem")}\n${pem}` };
    },
  };
}
