import type { SignedIn } from "@meetsanctum/auth-protocol";

import { coreJson, currentCredential, setCredential } from "../core-fetch";
import { setCoreBaseUrl } from "../core-url";
import {
  getShell,
  type FoundHost,
  type StoredHost,
  type TrustFailure,
} from "../shell";
import { hostStatus, type CheckedHost } from "./device";

// The host this client is paired with: its id and its home's, last known
// address, token and CA pin, kept by the shell.

// Points every core request at the host, and its token at that host only.
export function selectHost(host: StoredHost) {
  setCoreBaseUrl(host.url);
  setCredential({ url: host.url, token: host.token, pin: host.pin });
}

// Stores the client a claim, sign-in or pairing created, with the home and
// the pin of the candidate CA that first contact checked (checkHost): the
// shell pins it now.
export async function rememberSignIn(
  host: FoundHost,
  signedIn: Pick<SignedIn, "token" | "client">,
  { pin, homeId }: CheckedHost,
  signal?: AbortSignal,
): Promise<StoredHost> {
  signal?.throwIfAborted();
  const stored: StoredHost = {
    hostId: host.id,
    homeId,
    name: host.name,
    url: host.url,
    clientId: signedIn.client.id,
    token: signedIn.token,
    kind: signedIn.client.kind,
    pin,
  };
  await getShell().credentials.save(stored);
  if (signal?.aborted) {
    await getShell().credentials.forget(stored.token);
    signal.throwIfAborted();
  }
  selectHost(stored);
  return stored;
}

// After signing in again to a home whose certificate changed, the client this
// device had there is replaced: it is revoked with the new token, which the
// host just proved itself for. A restore, onto the same host or another, has
// revoked it already, and a shared client cannot revoke one, so this is best
// effort.
export async function replaceClient(previous: StoredHost, current: StoredHost) {
  if (
    previous.kind !== "personal" ||
    previous.homeId !== current.homeId ||
    previous.clientId === current.clientId
  ) {
    return;
  }
  await coreJson("/api/auth/clients/revoke", {
    method: "POST",
    json: { id: previous.clientId },
  }).catch(() => undefined);
}

// Forgets the host on this device. In a shell that checks certificates, the
// page may then come back in a fresh session (Shell.credentials.forget).
export async function forgetHost(host: StoredHost) {
  const credential = currentCredential();
  const isCurrent = credential?.token === host.token;
  if (isCurrent) {
    setCredential(null);
  }
  try {
    await getShell().credentials.forget(host.token);
  } catch (error) {
    // Keep address changes suspended while forgetting, but let the home
    // reconnect if storage failed. Never replace a newer sign-in.
    if (isCurrent && currentCredential() === null) {
      setCredential(credential);
    }
    throw error;
  }
}

async function answersAs(url: string, hostId: string) {
  try {
    return (await hostStatus(url)).hostId === hostId;
  } catch {
    return false;
  }
}

// Finds the stored host: at its last address while that answers as it, or
// wherever discovery finds its id once it stops answering. Calls `onFound`
// with each address it is found at; nothing re-pairs. A host that answers at
// several addresses, such as Ethernet and Wi-Fi, stays on one. Discovery
// also finds the same home on another host, as after a restore onto new
// hardware: its CA is another, so it fails the check. When none answers and
// one of them failed the certificate check, `onCertificate` gets that
// address, why and the host found there if discovery found one: another CA
// answered, so the home's certificate changed, or its own certificate is not
// valid now.
export function followHost(
  host: StoredHost,
  onFound: (url: string) => void | Promise<void>,
  onCertificate: (
    url: string,
    failure: TrustFailure,
    found?: FoundHost,
  ) => void = () => undefined,
): () => void {
  let isStopped = false;
  let isChecking = false;
  let hasCertificateFailure = false;
  let current: string | undefined;
  let candidates: FoundHost[] = [];
  const check = async () => {
    if (isChecking || isStopped) {
      return;
    }
    isChecking = true;
    try {
      // Serialize checks so a fast discovery answer cannot race the stored
      // address. Keep testing known candidates even without another event.
      const urls = new Set([
        current ?? host.url,
        host.url,
        ...candidates.map((candidate) => candidate.url),
      ]);
      for (const url of urls) {
        if (isStopped) return;
        if (!(await answersAs(url, host.hostId))) continue;
        if (!isStopped && (url !== current || hasCertificateFailure)) {
          await onFound(url);
          current = url;
          hasCertificateFailure = false;
        }
        return;
      }
      const trust = getShell().trust;
      for (const url of urls) {
        if (isStopped) return;
        const failure = await trust?.failure(url);
        if (isStopped) return;
        if (failure) {
          // Recovery at the same address must clear the certificate notice
          // too, without losing the last working address while it is away.
          hasCertificateFailure = true;
          onCertificate(
            url,
            failure,
            candidates.find((candidate) => candidate.url === url),
          );
          return;
        }
      }
    } catch {
      // A storage failure leaves the last address selected; retry later.
    } finally {
      isChecking = false;
    }
  };
  void check();
  const retry = setInterval(() => void check(), 10_000);
  const stop = getShell().discovery?.watch((hosts) => {
    candidates = hosts.filter(
      (candidate) =>
        candidate.id === host.hostId || candidate.homeId === host.homeId,
    );
    void check();
  });
  return () => {
    isStopped = true;
    clearInterval(retry);
    stop?.();
  };
}

// Records the host's new address.
export async function moveHost(host: StoredHost, url: string) {
  if (currentCredential()?.token !== host.token) return null;
  const moved = { ...host, url };
  await getShell().credentials.save(moved);
  if (currentCredential()?.token !== host.token) return null;
  selectHost(moved);
  return moved;
}
