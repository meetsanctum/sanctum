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
import { cn } from "cn";
import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { Skeleton } from "../components/ui/skeleton";
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
import { PairingCode } from "./pairing-code";
import { rememberSignIn } from "./session";
import { Sheet, SheetActions, SheetProblem, SheetStatus } from "./sheet";

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

// A shared device, "Everyone at home": nobody signs in here. The device
// shows its code, with a QR code that holds it, until someone types the code
// on another of the home's devices. The host then runs an exchange with this device that only
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

  const status = stopped
    ? "A wrong code was entered too many times, so this device stopped showing one."
    : problem;
  const formattedCode =
    shown && !stopped ? formatPairingCode(shown.code) : undefined;

  return (
    <Sheet
      wide
      title={`Add this device to ${host.name}`}
      subtitle="Nobody signs in here. Someone approves it from another device."
      back={{ onBack: props.onBack }}
    >
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {formattedCode}
      </span>
      {stopped ? (
        <div className="flex flex-col items-center gap-4 py-4">
          <SheetProblem>{status}</SheetProblem>
          <Button
            variant="default"
            size="lg"
            type="button"
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
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-5">
          <PairingCode formattedCode={formattedCode} />
          {shown ? (
            <QrCode
              text={pairingQrText({
                hostId: host.id,
                homeId: shown.homeId,
                code: shown.code,
              })}
              label="Pairing QR code"
              className="size-33 rounded-md"
            />
          ) : (
            <Skeleton className="size-33 rounded-md" />
          )}
        </div>
      )}
      <ol
        className={cn(
          "m-0 grid list-none gap-x-5 gap-y-3.5 p-0 sm:grid-cols-3",
          stopped && "opacity-55",
        )}
      >
        {[
          <>
            On a device that’s already connected to {host.name}, open{" "}
            <strong className="font-semibold">Settings → Clients</strong>.
          </>,
          <>
            Choose{" "}
            <strong className="font-semibold">Add a shared device</strong>.
          </>,
          <>Enter the code shown here, then approve this device.</>,
        ].map((step, index) => (
          <li
            key={index}
            className="flex items-start gap-3 text-[15px] leading-[21px]"
          >
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/11 text-[13px] font-semibold"
            >
              {index + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      {!stopped &&
        (status ? (
          <p
            role="status"
            className="m-0 flex items-start justify-center gap-2 text-center text-sm leading-5 text-destructive"
          >
            <CircleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0"
            />
            {status}
          </p>
        ) : (
          <SheetStatus>
            {shown ? "Waiting for approval…" : "Getting a code…"}
          </SheetStatus>
        ))}
      {props.recheck && props.onForgotten && isAnotherHome && (
        <SheetActions>
          <ChooseAnotherHome
            host={props.recheck}
            onForgotten={props.onForgotten}
            variant="link"
          />
        </SheetActions>
      )}
    </Sheet>
  );
}
