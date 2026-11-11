import {
  checkHostChain,
  findSigningCa,
  presentedAnchor,
  type HostAnchor,
} from "./host-chain.js";
import type { KeptHost, StoredHost, TrustFailure } from "./shell.js";

// What the desktop app trusts, checked for every HTTPS request and WebSocket
// the page makes, in the main process:
// - a paired host's pinned CA, stored with its token;
// - while the page checks a host at first contact, the first CA it sees, as
//   the only candidate, until a sign-in, claim or pairing pins it;
// - nothing else: an address that answers with another CA is not the host,
//   and the page reaches no other host, its fonts included (they ship with
//   it), so every connection is checked.
// Chromium caches each decision, acceptances and refusals alike, for as
// long as the page's session lives, so starting or abandoning a first
// contact, and forgetting the pin, are changes of trust that move the page
// to a fresh session (pages.ts); otherwise a cached acceptance, or an open
// connection, could outlive the candidate or pin that authorised it.
// Promoting the checked candidate changes nothing.

export const accept = 0;
export const refuse = -2;

type Credentials = {
  load(): Promise<KeptHost | null>;
  save(host: KeptHost): Promise<void>;
  forget(token: string): Promise<void>;
  replaceCaCertificate(pin: string, caCertificate: string): Promise<void>;
};

// Hosts are compared without IPv6 brackets.
function hostOf(hostname: string) {
  return hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

export function createHostTrust(options: {
  credentials: Credentials;
  now?: () => number;
}) {
  const { credentials } = options;
  const now = options.now ?? Date.now;
  let pinned: { hostId: string; anchor: HostAnchor | null } | null = null;
  let checking: { hostId: string; candidate: HostAnchor | null } | null = null;
  // Why the last connection to an address failed, since trust changed.
  const failures = new Map<string, TrustFailure>();
  // Moves on with every change of trust: a check that started under the
  // old trust is refused.
  let epoch = 0;

  function changeTrust(change: () => void) {
    change();
    epoch += 1;
    failures.clear();
  }

  async function verify(
    hostname: string,
    chain: string[],
    // The checked certificates, so the page can limit cached acceptances
    // and retry date-related refusals after the clock is corrected.
    onChecked?: (certificates: string[], isAccepted: boolean) => void,
  ) {
    const acceptChain = (ca: string) => {
      onChecked?.([chain[0]!, ca], true);
      return accept;
    };
    const host = hostOf(hostname);
    const startedIn = epoch;
    const at = now();
    if (checking) {
      const seen = await presentedAnchor(chain, at);
      if (startedIn !== epoch) {
        return refuse;
      }
      // Saving the checked candidate does not change trust. A concurrent
      // verification of that same CA must not cache a refusal.
      if (!checking) {
        return seen && pinned?.anchor?.pin === seen.pin
          ? acceptChain(seen.caCertificate)
          : refuse;
      }
      if (!seen) {
        onChecked?.(chain, false);
        failures.set(host, "invalid");
        return refuse;
      }
      checking.candidate ??= seen;
      if (checking.candidate.pin !== seen.pin) {
        failures.set(host, "changed");
        return refuse;
      }
      failures.delete(host);
      return acceptChain(seen.caCertificate);
    }
    const anchor = pinned?.anchor;
    if (!anchor) {
      return refuse;
    }
    const ca = await checkHostChain(chain, anchor, at);
    if (startedIn !== epoch || pinned?.anchor?.pin !== anchor.pin) {
      return refuse;
    }
    if (!ca) {
      // The host's own certificate at the wrong time, another CA, or
      // something that is no host at all.
      const ours = await findSigningCa(
        [...chain, anchor.caCertificate],
        anchor.pin,
      );
      const other = ours ? undefined : await presentedAnchor(chain, at);
      if (startedIn !== epoch) {
        return refuse;
      }
      if (ours) {
        onChecked?.([chain[0]!, ours], false);
        failures.set(host, "invalid");
      } else if (other) {
        failures.set(host, "changed");
      }
      return refuse;
    }
    failures.delete(host);
    if (ca !== anchor.caCertificate) {
      // The host sent its CA certificate re-signed with the same key: keep
      // the checked replacement.
      pinned = { ...pinned!, anchor: { pin: anchor.pin, caCertificate: ca } };
      await credentials
        .replaceCaCertificate(anchor.pin, ca)
        .catch(() => undefined);
    }
    // Saving a renewed CA yields too: trust may have changed meanwhile.
    return startedIn === epoch ? acceptChain(ca) : refuse;
  }

  return {
    // The stored host's pin, when the app starts.
    async start() {
      const host = await credentials.load();
      pinned = host && {
        hostId: host.hostId,
        anchor:
          host.pin && host.caCertificate
            ? { pin: host.pin, caCertificate: host.caCertificate }
            : null,
      };
    },

    verify,

    // Starts checking the host with `hostId` as a first contact, or with
    // null, ends it. Asking again for the same host keeps its candidate.
    // Returns whether trust changed, and the page needs a fresh session.
    check(hostId: string | null) {
      if (hostId === null ? !checking : checking?.hostId === hostId) {
        return false;
      }
      changeTrust(() => {
        checking = hostId === null ? null : { hostId, candidate: null };
      });
      return true;
    },

    // While checking a first contact, no request may carry a token.
    isChecking: () => checking !== null,

    // The candidate's pin, once a connection has presented one.
    candidate: () => checking?.candidate?.pin ?? null,

    // Why the last connection to `url` failed its check, if it did.
    failure(url: string) {
      try {
        return failures.get(hostOf(new URL(url).hostname)) ?? null;
      } catch {
        return null;
      }
    },

    // Stores the host a claim, sign-in or pairing created, with the pin the
    // page checked: the candidate, which it promotes, or the pin already
    // stored for that host, as when its address changes.
    async save(host: StoredHost) {
      const startedIn = epoch;
      let anchor: HostAnchor | null = null;
      if (host.pin !== null) {
        const candidate =
          checking?.hostId === host.hostId ? checking.candidate : null;
        const stored = pinned?.hostId === host.hostId ? pinned.anchor : null;
        anchor =
          candidate?.pin === host.pin
            ? candidate
            : stored?.pin === host.pin
              ? stored
              : null;
        if (!anchor) {
          throw new Error("Not the host this app checked");
        }
      } else if (!/^http:/.test(host.url)) {
        throw new Error("A host over HTTPS has a pin");
      }
      await credentials.save({
        ...host,
        caCertificate: anchor?.caCertificate ?? null,
      });
      if (startedIn !== epoch) {
        // A page can be replaced while its write is in flight. Do not let
        // that old page pin an abandoned candidate or retain its token.
        await credentials.forget(host.token);
        throw new Error("The host's trust changed while saving");
      }
      // The same CA that was accepted as the candidate: trust does not
      // change, so the page keeps its session.
      pinned = { hostId: host.hostId, anchor };
      if (checking?.hostId === host.hostId) {
        checking = null;
      }
    },

    // Forgets the stored host if it still holds `token`. Returns whether its
    // pin went, and the page needs a fresh session.
    async forget(token: string) {
      await credentials.forget(token);
      if (pinned && !(await credentials.load())) {
        changeTrust(() => (pinned = null));
        return true;
      }
      return false;
    },
  };
}

export type HostTrust = ReturnType<typeof createHostTrust>;
