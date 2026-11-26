import {
  formatPairingCode,
  pairingExchangesPerRequest,
  pairingQrText,
  type NewClient,
  type PairingExchangeIds,
  type PairPolled,
  type PairRequested,
} from "@meetsanctum/auth-protocol";
import { Button } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

import { Sheet } from "../components";
import { CoreError } from "../core-fetch";
import { QrCode } from "../qr-code";
import { getShell, type FoundHost, type StoredHost } from "../shell";
import { ChooseAnotherHome } from "../connection-veil";
import { checkHost, SignInError, type CheckedHost } from "./device";
import { problemText } from "./messages";
import {
  confirmsPairing,
  pollPairing,
  prepareExchange,
  requestPairing,
  showCode,
  waitForPairingPoll,
  type ShownCode,
} from "./pairing";
import { rememberSignIn } from "./session";

const pollMs = 2_000;
const retryMaxMs = 15_000;

// How many codes this device lets anyone try. Whoever sits in between at
// first contact can start exchanges as fast as they like, each one a guess at
// the code, so the device counts the exchanges it answers itself, across
// codes, and nothing the host says resets the count: a few for each code, a
// pause between answers, and once enough codes didn't match it answers none
// until someone here asks for a new code.
const answersPerCode = pairingExchangesPerRequest;
const answersInAll = 2 * pairingExchangesPerRequest;
const answerGapMs = 5_000;
const usedUpPauseMs = 30_000;

// "This is a shared device": nobody signs in here. The device shows a QR
// code and its display code until someone types the code on another of the
// home's devices. The host then runs an exchange with this device that only
// finishes for the code it shows, bound to the certificate it sees, so a
// finished exchange means this device reached the home whose device typed
// the code. Someone approves it there, and the device collects its token
// and checks the host's confirmation before it saves it. A request expires
// after 10 minutes, and the device shows a new code.
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
  const [shown, setShown] = useState<{ code: string; homeId: string }>();
  const [problem, setProblem] = useState<string>();
  // Another home answers at the address (SignIn.tsx).
  const [isAnotherHome, setIsAnotherHome] = useState(false);
  // Enough codes didn't match: nothing more is answered until someone here
  // asks for a new code, which starts the count again.
  const [stopped, setStopped] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      const shell = getShell();
      let client: NewClient | undefined;
      let request: PairRequested | undefined;
      let code: ShownCode | undefined;
      // Set with the request, before anything is polled.
      let checked: CheckedHost | undefined;
      let pending:
        | { send: ReturnType<typeof prepareExchange>; ids: PairingExchangeIds }
        | undefined;
      // The exchange that checked this device, which the token must match.
      let verified: { sessionKey: string; ids: PairingExchangeIds } | undefined;
      let paired: Extract<PairPolled, { status: "paired" }> | undefined;
      let answers = 0;
      let answeredInAll = 0;
      let answeredAt = -Infinity;
      let delay = pollMs;
      const newCode = () => {
        request = undefined;
        code = undefined;
        pending = undefined;
        verified = undefined;
        setShown(undefined);
      };
      const codeUsedUp = () =>
        answers >= answersPerCode || answeredInAll >= answersInAll;
      const rotateUsedUpCode = async () => {
        newCode();
        if (answeredInAll < answersInAll) {
          await waitForPairingPoll(usedUpPauseMs, signal);
        }
      };
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
          if (!request || !code) {
            if (answeredInAll >= answersInAll) {
              setStopped(true);
              return;
            }
            checked = await checkHost(host, signal);
            request = await requestPairing(host.url, client, signal);
            code = await showCode(request.lookup);
            signal.throwIfAborted();
            answers = 0;
            setShown({ code: code.code, homeId: checked.homeId });
          }
          const view = {
            hostId: host.id,
            homeId: checked!.homeId,
            pin: checked!.pin,
          };
          if (!paired && !pending) {
            const polled = await pollPairing(
              host.url,
              request.deviceSecret,
              signal,
            );
            signal.throwIfAborted();
            if (polled.status === "exchange") {
              if (codeUsedUp()) {
                await rotateUsedUpCode();
                continue;
              }
              if (Date.now() - answeredAt >= answerGapMs) {
                answers += 1;
                answeredInAll += 1;
                answeredAt = Date.now();
                const ids = {
                  requestId: request.requestId,
                  exchangeId: polled.exchangeId,
                };
                pending = {
                  ids,
                  send: prepareExchange({
                    url: host.url,
                    shown: code,
                    deviceSecret: request.deviceSecret,
                    ids,
                    startLoginRequest: polled.startLoginRequest,
                    host: view,
                    signal,
                  }),
                };
              }
            } else if (polled.status === "paired") {
              // Only a token the checked host confirms, on the certificate
              // this device checked it on, is ever saved.
              const confirmed =
                verified &&
                (await confirmsPairing(
                  verified.sessionKey,
                  view,
                  verified.ids,
                  polled,
                )) &&
                (!view.pin || (await shell.trust?.candidate()) === view.pin);
              signal.throwIfAborted();
              if (!confirmed) {
                throw new SignInError("unconfirmed");
              }
              paired = polled;
            }
          }
          if (pending) {
            const { ids, send } = pending;
            const sessionKey = await send();
            signal.throwIfAborted();
            pending = undefined;
            if (sessionKey) {
              verified = { sessionKey, ids };
            } else if (codeUsedUp()) {
              await rotateUsedUpCode();
              continue;
            }
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
            if (pending && codeUsedUp()) {
              await rotateUsedUpCode();
            } else {
              newCode();
            }
            continue;
          }
          if (
            pending &&
            error instanceof CoreError &&
            error.status < 500 &&
            error.code !== "busy"
          ) {
            pending = undefined;
            if (codeUsedUp()) {
              await rotateUsedUpCode();
              continue;
            }
          }
          if (error instanceof SignInError && error.code === "unconfirmed") {
            // Whoever answered can't show it is the home that approved this
            // device: its code is dropped.
            newCode();
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
          if (error instanceof CoreError && error.code === "pairing_outdated") {
            return;
          }
          delay = Math.min(delay * 2, retryMaxMs);
        }
        await waitForPairingPoll(delay, signal);
      }
    })();
    return () => controller.abort();
  }, [host, onPaired, round]);

  return (
    <Sheet
      title={`Pair with ${host.name}`}
      onBack={props.onBack}
      intro={
        <>
          <p className="muted">
            To approve this device, open Settings → Clients on a device that’s
            already connected to this home. Choose Add a shared device, then
            enter this code.
          </p>
          <p
            className={problem || stopped ? "problem" : "notice"}
            role="status"
          >
            {stopped
              ? "Several codes didn’t match, so this device stopped answering."
              : (problem ??
                (shown ? "Waiting for approval…" : "Getting a code…"))}
          </p>
          {stopped && (
            <Button
              type="button"
              className="self-start"
              onClick={() => {
                setStopped(false);
                setShown(undefined);
                // The previous request can still count against the address
                // cap until it expires.
                setRound((current) => current + 1);
              }}
            >
              Show a new code
            </Button>
          )}
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
        {shown && !stopped ? (
          <>
            <QrCode
              text={pairingQrText({
                hostId: host.id,
                homeId: shown.homeId,
                code: shown.code,
              })}
              label="Pairing QR code"
              className="size-[220px] rounded-sm"
            />
            <strong className="text-[32px] leading-10 font-light tabular-nums">
              {formatPairingCode(shown.code)}
            </strong>
          </>
        ) : (
          <span className="block size-[220px] rounded-sm bg-foreground/6" />
        )}
      </div>
    </Sheet>
  );
}
