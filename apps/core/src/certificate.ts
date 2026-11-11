import { spkiPin } from "@meetsanctum/auth-protocol";
import { generateKeyPairSync, X509Certificate } from "node:crypto";

// The core's HTTPS certificate. The core makes a P-256 key in memory and the
// manager, the host's CA, signs it over the socket: on every start, and
// again when a third of its life is left, swapped in without a restart. The
// key is never written anywhere, so it is in no backup. Without a
// certificate the core serves nothing: it waits for the manager, and never
// falls back to plain HTTP.

export type SignedCertificate = { certificate: string; ca: string };

export type CoreCertificate = {
  // The private key, in memory only, and the chain the core serves: its
  // certificate, then the CA's, which the apps pin.
  key: string;
  cert: string;
  // The CA's pin, which Auth binds sign-ins to.
  pin: string;
  notBefore: number;
  notAfter: number;
  // When to ask for the next one.
  renewAt: number;
  // Dated ahead of this clock when it arrived: an unsynchronised manager
  // dates from its last signing time, and asking again would give the same
  // dates.
  startedAhead: boolean;
};

const checkEveryMs = 60_000;

async function issue(
  sign: (publicKey: string) => Promise<SignedCertificate>,
  now: () => number,
): Promise<CoreCertificate> {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const signed = await sign(
    publicKey.export({ type: "spki", format: "pem" }) as string,
  );
  const leaf = new X509Certificate(signed.certificate);
  const ca = new X509Certificate(signed.ca);
  // The manager answers over a socket only the core mounts, but serving a
  // chain the apps would refuse helps nobody.
  if (
    !leaf.publicKey.equals(publicKey) ||
    !ca.ca ||
    !leaf.checkIssued(ca) ||
    !leaf.verify(ca.publicKey)
  ) {
    throw new Error("The manager's certificate does not fit the core's key");
  }
  const receivedAt = now();
  const notBefore = Date.parse(leaf.validFrom);
  const notAfter = Date.parse(leaf.validTo);
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    cert: `${signed.certificate.trimEnd()}\n${signed.ca.trimEnd()}\n`,
    pin: await spkiPin(
      new Uint8Array(ca.publicKey.export({ type: "spki", format: "der" })),
    ),
    notBefore,
    notAfter,
    startedAhead: notBefore > receivedAt,
    // A third of its life left, counted from when it arrived rather than
    // from its start an hour back.
    renewAt: receivedAt + ((notAfter - receivedAt) * 2) / 3,
  };
}

export function createCoreCertificates(options: {
  // Asks the manager until it answers (manager.ts).
  sign: (publicKey: string) => Promise<SignedCertificate>;
  log: (message: string) => void;
  now?: () => number;
  checkEveryMs?: number;
}) {
  const { sign, log } = options;
  const now = options.now ?? Date.now;
  let current: CoreCertificate | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let renewing = false;

  async function renew(onRenewed: (next: CoreCertificate) => void) {
    renewing = true;
    try {
      const next = await issue(sign, now);
      onRenewed(next);
      current = next;
      log(
        `certificate: renewed until ${new Date(next.notAfter).toISOString()}`,
      );
    } catch (error) {
      // The current one keeps serving; the next check asks again.
      log(
        `certificate: could not renew (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      renewing = false;
    }
  }

  return {
    // The first certificate, once the manager has signed it.
    async first() {
      current ??= await issue(sign, now);
      log(
        `certificate: valid until ${new Date(current.notAfter).toISOString()}`,
      );
      return current;
    },

    current: () => current,

    // Checks the certificate now and then, by the wall clock, so a clock
    // corrected after a power cut also gets a replacement at once: one that
    // has ended, or that has not started by the corrected time. One that had
    // not started when it arrived waits for its renewal time.
    watch(onRenewed: (next: CoreCertificate) => void) {
      clearInterval(timer);
      timer = setInterval(() => {
        const at = now();
        if (
          current &&
          !renewing &&
          (at >= current.renewAt ||
            (at < current.notBefore && !current.startedAhead))
        ) {
          void renew(onRenewed);
        }
      }, options.checkEveryMs ?? checkEveryMs);
      timer.unref();
    },

    close() {
      clearInterval(timer);
    },
  };
}

export type CoreCertificates = ReturnType<typeof createCoreCertificates>;
