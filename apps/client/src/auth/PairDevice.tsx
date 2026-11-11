import {
  formatPairingCode,
  pairingQrText,
  shortPin,
  type NewClient,
  type PairPolled,
  type PairRequested,
} from "@meetsanctum/auth-protocol";
import { useEffect, useState } from "react";

import { Sheet } from "../components";
import { CoreError } from "../core-fetch";
import { QrCode } from "../qr-code";
import { getShell, type FoundHost, type StoredHost } from "../shell";
import { ChooseAnotherHome } from "../connection-veil";
import { checkHost, SignInError, type CheckedHost } from "./device";
import { problemText } from "./messages";
import { pollPairing, requestPairing } from "./pairing";
import { rememberSignIn } from "./session";

const pollMs = 2_000;
const retryMaxMs = 15_000;

// Waits, or stops waiting once the screen is left. A device can wait here
// for days, so nothing is left behind on the signal.
function wait(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

// "This is a shared device": nobody signs in here. The device shows a QR
// code and its display code until someone approves it from another of the
// home's devices, then collects its token. A request expires after 10
// minutes, and the device shows a new code. The QR code carries the pin of
// the certificate this device sees, and the short pin shows under the code,
// so the approving device can check that both see the same host.
export function PairDevice(props: {
  host: FoundHost;
  onBack: () => void;
  onPaired: (host: StoredHost) => void;
  // The stored host whose certificate changed, when this checks it again,
  // and what follows once it is forgotten.
  recheck?: StoredHost;
  onForgotten?: () => void;
}) {
  const { host, onPaired } = props;
  const [shown, setShown] = useState<PairRequested & CheckedHost>();
  const [problem, setProblem] = useState<string>();
  // Another home answers at the address (SignIn.tsx).
  const [isAnotherHome, setIsAnotherHome] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      const shell = getShell();
      let client: NewClient | undefined;
      let request: PairRequested | undefined;
      // Set with the request, before anything is polled.
      let checked: CheckedHost | undefined;
      let paired: Extract<PairPolled, { status: "paired" }> | undefined;
      let delay = pollMs;
      while (!signal.aborted) {
        try {
          if (!client) {
            client = {
              name:
                (await shell.deviceName()).trim().slice(0, 60) ||
                "Shared device",
              platform: shell.platform,
            };
            signal.throwIfAborted();
          }
          if (!request) {
            checked = await checkHost(host, signal);
            request = await requestPairing(host.url, client, signal);
            setShown({ ...request, ...checked });
          }
          if (!paired) {
            const polled = await pollPairing(
              host.url,
              request.deviceSecret,
              signal,
            );
            signal.throwIfAborted();
            if (polled.status === "paired") paired = polled;
          }
          setProblem(undefined);
          setIsAnotherHome(false);
          delay = pollMs;
          if (paired) {
            // Collection is one-time. Keep the received token while a local
            // storage failure is retried instead of consuming another request.
            const stored = await rememberSignIn(host, paired, checked!, signal);
            signal.throwIfAborted();
            onPaired(stored);
            return;
          }
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof CoreError && error.code === "expired") {
            // Expired, or cancelled: ask for a new code at once.
            request = undefined;
            setShown(undefined);
            continue;
          }
          setProblem(
            paired
              ? "Can't save this device's sign-in. Retrying…"
              : !client
                ? "Can't read this device's name. Retrying…"
                : problemText(error),
          );
          setIsAnotherHome(
            error instanceof SignInError && error.code === "another_host",
          );
          delay = Math.min(delay * 2, retryMaxMs);
        }
        await wait(delay, signal);
      }
    })();
    return () => controller.abort();
  }, [host, onPaired]);

  return (
    <Sheet
      title={`Pair with ${host.name}`}
      onBack={props.onBack}
      intro={
        <>
          <p className="muted">
            Someone approves this device from another of the home's devices: in
            Settings, under Clients, they add a shared device and scan this code
            or type it.
          </p>
          <p className={problem ? "problem" : "notice"} role="status">
            {problem ??
              (shown
                ? "Waiting for someone to approve it…"
                : "Getting a code…")}
          </p>
          {props.recheck && props.onForgotten && isAnotherHome && (
            <ChooseAnotherHome
              host={props.recheck}
              onForgotten={props.onForgotten}
              variant="link"
            />
          )}
        </>
      }
    >
      <div className="flex flex-col items-center gap-3" aria-live="polite">
        {shown ? (
          <>
            <QrCode
              text={pairingQrText({
                hostId: host.id,
                homeId: shown.homeId,
                code: shown.code,
                pin: shown.pin,
              })}
              label="Pairing QR code"
              className="size-[220px] rounded-sm"
            />
            <strong className="text-[32px] leading-10 font-light tabular-nums">
              {formatPairingCode(shown.code)}
            </strong>
            {shown.pin && (
              <span className="row-detail tabular-nums">
                Home certificate {shortPin(shown.pin)}
              </span>
            )}
          </>
        ) : (
          <span className="block size-[220px] rounded-sm bg-foreground/6" />
        )}
      </div>
    </Sheet>
  );
}
