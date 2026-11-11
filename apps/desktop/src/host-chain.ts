import { spkiPin } from "@meetsanctum/auth-protocol";
import { X509Certificate } from "node:crypto";

// The rule every connection to a host must pass: its certificate is a server
// certificate signed directly by the host CA, both are valid now, and the
// CA's public key matches the pin. Names are not checked, since the host CA
// signs only that host's core, and the system's trusted roots play no part.

// A host CA as a client keeps it: its pin, and the certificate it was seen
// with, the anchor when a host does not send it again.
export type HostAnchor = { pin: string; caCertificate: string };

const serverAuth = "1.3.6.1.5.5.7.3.1";

function parse(pem: string) {
  try {
    return new X509Certificate(pem);
  } catch {
    return undefined;
  }
}

function validAt(certificate: X509Certificate, now: number) {
  return (
    Date.parse(certificate.validFrom) <= now &&
    now <= Date.parse(certificate.validTo)
  );
}

// A self-signed CA certificate, valid now.
function isCa(certificate: X509Certificate, now: number) {
  return (
    certificate.ca &&
    certificate.checkIssued(certificate) &&
    certificate.verify(certificate.publicKey) &&
    validAt(certificate, now)
  );
}

// A server certificate `ca` signed itself, valid now.
function isServedBy(leaf: X509Certificate, ca: X509Certificate, now: number) {
  return (
    !leaf.ca &&
    (leaf.keyUsage ?? []).includes(serverAuth) &&
    validAt(leaf, now) &&
    leaf.checkIssued(ca) &&
    leaf.verify(ca.publicKey)
  );
}

export function pinOf(certificate: X509Certificate) {
  return spkiPin(
    new Uint8Array(
      certificate.publicKey.export({ type: "spki", format: "der" }),
    ),
  );
}

/**
 * The CA certificate a presented chain (leaf first) passes with under
 * `anchor`, or none. A reissued CA certificate in the chain, the same key
 * with new dates, is preferred to the stored one once it checks out, so an
 * expired stored certificate never stands in its way; the caller stores it.
 */
export async function checkHostChain(
  chain: string[],
  anchor: HostAnchor,
  now = Date.now(),
): Promise<string | undefined> {
  const leaf = chain[0] === undefined ? undefined : parse(chain[0]);
  if (!leaf) {
    return undefined;
  }
  for (const pem of [...chain.slice(1), anchor.caCertificate]) {
    const ca = parse(pem);
    if (
      ca &&
      (await pinOf(ca)) === anchor.pin &&
      isCa(ca, now) &&
      isServedBy(leaf, ca, now)
    ) {
      return pem;
    }
  }
  return undefined;
}

/**
 * The CA in `chain` that signed the server's certificate and has `pin`,
 * whatever their dates: the host's own certificate, at the wrong time, as
 * when its clock or this device's is wrong.
 */
export async function findSigningCa(chain: string[], pin: string) {
  const leaf = chain[0] === undefined ? undefined : parse(chain[0]);
  if (!leaf) {
    return undefined;
  }
  for (const pem of chain.slice(1)) {
    const ca = parse(pem);
    if (
      ca &&
      (await pinOf(ca)) === pin &&
      leaf.checkIssued(ca) &&
      leaf.verify(ca.publicKey)
    ) {
      return pem;
    }
  }
  return undefined;
}

/**
 * The host CA a chain presents at first contact, if the chain is a valid host
 * chain in itself. The app holds it as a candidate and pins it only once the
 * first contact has been checked.
 */
export async function presentedAnchor(
  chain: string[],
  now = Date.now(),
): Promise<HostAnchor | undefined> {
  const leaf = chain[0] === undefined ? undefined : parse(chain[0]);
  if (!leaf) {
    return undefined;
  }
  for (const pem of chain.slice(1)) {
    const ca = parse(pem);
    if (ca && isCa(ca, now) && isServedBy(leaf, ca, now)) {
      return { pin: await pinOf(ca), caCertificate: pem };
    }
  }
  return undefined;
}
