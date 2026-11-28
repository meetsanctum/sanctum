import {
  formatPairingCode,
  normalisePairingCode,
  pairingCodeAlphabet,
  pairingCodeLength,
  type PairExchangeFailure,
  type PairExchangeStarted,
  type PairingRequestInfo,
  type Platform,
} from "@meetsanctum/auth-protocol";
import {
  Button,
  FieldProblem,
  Input,
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
  Problem,
} from "@meetsanctum/ui-sdk";
import { Globe, Monitor, Tablet } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { productName } from "./brand";
import { CoreError } from "./core-fetch";
import { problemReason } from "./device-parts";
import {
  approvePairing,
  lookupPairing,
  pairingExchange,
  waitForPairingPoll,
} from "./auth/pairing";
import { useAuthAttempt } from "./auth/use-auth-attempt";
import { platformNames } from "./platforms";

// The approval screen, on every client: type the code a shared device shows,
// and the core checks that device through an exchange only the device
// showing the code can finish, on a connection to this host. Once it is
// checked, this client sees what asked, names it and approves it. The device
// then collects its token itself, and joins Settings → Linked Devices.

type Step =
  | { name: "code" }
  | {
      name: "details";
      code: string;
      exchange: PairExchangeStarted;
      request: PairingRequestInfo;
    }
  | { name: "done"; deviceName: string };

// How often the exchange is asked after, and how long at most: the core
// gives the device 30 seconds to answer each of its steps.
const exchangeMs = 1_000;
const exchangeLimitMs = 75_000;

const codeSlots = Array.from(
  { length: pairingCodeLength },
  (_, index) => index,
);
const codeMidpoint = pairingCodeLength / 2;
const lookAlikeCharacter = /[01ILOU]/;
const lookAlikeNote =
  "Codes don’t use 0, 1, I, L, O or U. Check the code on the device.";
const invalidPasteNote =
  "That isn’t a code. Codes have 8 letters and digits, such as K7QX-M4PD.";

class ExchangeFailed extends Error {
  constructor(readonly reason: PairExchangeFailure | "timeout") {
    super(reason);
  }
}

// What went wrong: with the code or name typed, said under its field, or
// with Sanctum, said as a notice of what didn't happen.
type Trouble = { field: string } | { title: string; reason: string };

function troubleOf(
  error: unknown,
  step: "code" | "details",
  code: string | undefined,
  name: string,
): Trouble {
  const said = pairingErrorText(error, code);
  // On the name's step only the name is a field; what the code says there
  // is why the device wasn't approved.
  const isName = error instanceof CoreError && error.code === "invalid_request";
  const wrongConnection =
    error instanceof ExchangeFailed && error.reason === "channel_mismatch";
  if (said && ((step === "code" && !wrongConnection) || isName)) {
    return { field: said };
  }
  return {
    title:
      step === "code" ? "Couldn't find the device" : `${name} wasn't approved`,
    reason:
      said ??
      (error instanceof CoreError && error.code === "busy"
        ? `${productName} can’t check this device right now. Try again in a moment.`
        : problemReason(error)),
  };
}

function pairingErrorText(error: unknown, code?: string) {
  if (error instanceof ExchangeFailed) {
    switch (error.reason) {
      case "wrong_code":
        return "That code doesn’t match the one on the device. Check it and try again.";
      case "no_answer":
      case "timeout":
        return "The device didn’t answer. Check that it still shows this code, then try again.";
      case "unchecked":
        return `${productName} couldn’t check this device, so it can’t join. Enter the new code it shows.`;
      case "channel_mismatch":
        return `This device isn’t connected to ${productName} directly, so it can’t join. Something on your network may be in between.`;
    }
  }
  if (error instanceof CoreError) {
    switch (error.code) {
      case "not_found":
        return `No device is showing ${code ? formatPairingCode(code) : "this code"}. Its code changes every 10 minutes, so check the one it shows now.`;
      case "too_many_attempts":
        return "Too many codes were tried for this device. Enter the new code it shows.";
      case "invalid_request":
        return "Check the name.";
    }
  }
  return undefined;
}

// The name a device suggests, unless it only names its kind: a browser
// can't tell what it runs on.
function suggestedName(request: PairingRequestInfo) {
  const name = request.suggestedName.trim();
  return name === platformNames[request.platform] || name === "Shared device"
    ? ""
    : name;
}

function PlatformIcon(props: { platform: Platform }) {
  const Icon =
    props.platform === "web"
      ? Globe
      : props.platform === "ios" || props.platform === "android"
        ? Tablet
        : Monitor;
  return <Icon aria-hidden="true" className="size-5" />;
}

export function ApproveDevice(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApproved: () => void;
}) {
  const [step, setStep] = useState<Step>({ name: "code" });
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<Trouble>();
  // A character the code never uses was typed, and left out.
  const [lookAlike, setLookAlike] = useState(false);
  const [pasteNote, setPasteNote] = useState<string>();
  const [working, setWorking] = useState(false);
  // The core keeps a verified exchange for this approver while the device
  // is waiting, so use its IDs again if the approver goes back or reopens.
  const verified = useRef<{ code: string; exchange: PairExchangeStarted }>(
    undefined,
  );
  const { start, cancel } = useAuthAttempt();

  useEffect(() => {
    cancel();
    if (props.open) {
      setStep({ name: "code" });
      setCode("");
      setProblem(undefined);
      setLookAlike(false);
      setPasteNote(undefined);
      setWorking(false);
    }
  }, [props.open, cancel]);

  const run = async (
    action: (signal: AbortSignal) => Promise<void>,
    on: "code" | "details",
    typed?: string,
  ) => {
    const signal = start();
    setWorking(true);
    setProblem(undefined);
    try {
      await action(signal);
    } catch (error) {
      if (!signal.aborted) setProblem(troubleOf(error, on, typed, name.trim()));
    } finally {
      if (!signal.aborted) setWorking(false);
    }
  };

  // Looks the code up as soon as its last character is typed, or when the
  // form is sent again after a problem.
  const find = (typed: string) => {
    const normalised = normalisePairingCode(typed);
    if (!normalised || working) {
      return;
    }
    setPasteNote(undefined);
    void run(
      async (signal) => {
        const previous = verified.current;
        const exchange =
          previous?.code === normalised
            ? previous.exchange
            : await lookupPairing(normalised, signal);
        signal.throwIfAborted();
        const deadline = new AbortController();
        const checking = AbortSignal.any([signal, deadline.signal]);
        const timer = setTimeout(
          () => deadline.abort(new ExchangeFailed("timeout")),
          exchangeLimitMs,
        );
        try {
          for (;;) {
            checking.throwIfAborted();
            const status = await pairingExchange(exchange, checking);
            checking.throwIfAborted();
            if (status.status === "failed") {
              throw new ExchangeFailed(status.reason);
            }
            if (status.status === "verified") {
              verified.current = { code: normalised, exchange };
              setName(suggestedName(status.request));
              setStep({
                name: "details",
                code: normalised,
                exchange,
                request: status.request,
              });
              return;
            }
            await waitForPairingPoll(exchangeMs, checking);
          }
        } catch (error) {
          checking.throwIfAborted();
          if (
            verified.current?.exchange === exchange &&
            error instanceof CoreError &&
            error.code === "not_found"
          ) {
            verified.current = undefined;
          }
          throw error;
        } finally {
          clearTimeout(timer);
        }
      },
      "code",
      normalised,
    );
  };

  const approve = (event: FormEvent) => {
    event.preventDefault();
    const deviceName = name.trim();
    if (step.name !== "details" || working || !deviceName) return;
    void run(async (signal) => {
      await approvePairing({ ...step.exchange, name: deviceName }, signal);
      signal.throwIfAborted();
      verified.current = undefined;
      setStep({ name: "done", deviceName });
      props.onApproved();
    }, "details");
  };

  const named = step.name === "details" && suggestedName(step.request);
  const codeNote =
    pasteNote ?? (lookAlike && !problem ? lookAlikeNote : undefined);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        cancel();
        props.onOpenChange(open);
      }}
    >
      <DialogContent>
        {step.name === "code" && (
          <form
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              find(code);
            }}
            className="flex flex-col gap-5"
          >
            <DialogHeader>
              <DialogTitle>Add a shared device</DialogTitle>
              <DialogDescription>
                On the wall display or tablet, choose your home, then “Everyone
                at home”. Enter the code it shows.
              </DialogDescription>
            </DialogHeader>
            <InputOTP
              aria-label="Code shown on the device"
              aria-invalid={problem && "field" in problem ? true : undefined}
              maxLength={pairingCodeLength}
              value={code}
              readOnly={working}
              filter={(typed) => {
                const upper = typed.toUpperCase();
                setPasteNote(undefined);
                setLookAlike(lookAlikeCharacter.test(upper));
                return [...upper]
                  .filter((char) => pairingCodeAlphabet.includes(char))
                  .join("");
              }}
              onPaste={(event) => {
                if (working) return;
                const text = event.clipboardData.getData("text/plain");
                const completeCode = normalisePairingCode(text);
                if (completeCode) {
                  event.preventDefault();
                  setCode(completeCode);
                  setLookAlike(false);
                  find(completeCode);
                  return;
                }
                const input = event.currentTarget;
                const pasted = text.toUpperCase().replace(/[\s-]/g, "");
                const selectionStart = input.selectionStart ?? 0;
                const selectionEnd = input.selectionEnd ?? input.value.length;
                const nextLength =
                  input.value.length -
                  (selectionEnd - selectionStart) +
                  pasted.length;
                const fits = nextLength <= pairingCodeLength;
                const invalidCharacters = [...pasted].filter(
                  (char) => !pairingCodeAlphabet.includes(char),
                );
                if (!fits || invalidCharacters.length > 0) {
                  event.preventDefault();
                  setPasteNote(
                    fits &&
                      invalidCharacters.every((char) =>
                        lookAlikeCharacter.test(char),
                      )
                      ? lookAlikeNote
                      : invalidPasteNote,
                  );
                }
              }}
              onChange={(next) => {
                setCode(next);
                setProblem(undefined);
              }}
              onComplete={find}
              enterKeyHint="go"
              autoFocus
            >
              <InputOTPGroup>
                {codeSlots.slice(0, codeMidpoint).map((index) => (
                  <InputOTPSlot key={index} index={index} />
                ))}
              </InputOTPGroup>
              <InputOTPSeparator />
              <InputOTPGroup>
                {codeSlots.slice(codeMidpoint).map((index) => (
                  <InputOTPSlot key={index} index={index} />
                ))}
              </InputOTPGroup>
            </InputOTP>
            {codeNote && (
              <p role="status" className="m-0 text-sm text-muted-foreground">
                {codeNote}
              </p>
            )}
            <TroubleLine trouble={problem} />
            <DialogFooter>
              <Button
                type="submit"
                disabled={working || code.length < pairingCodeLength}
              >
                {working ? "Finding the device…" : "Find the device"}
              </Button>
            </DialogFooter>
          </form>
        )}
        {step.name === "details" && (
          <form onSubmit={approve} className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>Approve this device?</DialogTitle>
              <DialogDescription>
                Anyone who uses it can see and control everything in the home,
                without signing in.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-3 rounded-md bg-foreground/6 p-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-foreground/8 text-muted-foreground">
                <PlatformIcon platform={step.request.platform} />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm font-medium">
                  {named || platformNames[step.request.platform]}
                </span>
                <span className="text-[13px] text-muted-foreground tabular-nums">
                  {named ? `${platformNames[step.request.platform]} · ` : ""}
                  Code {formatPairingCode(step.code)}
                </span>
              </span>
            </div>
            <label className="flex flex-col gap-2">
              <span className="text-[13px] font-medium text-muted-foreground">
                Name
              </span>
              <Input
                value={name}
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
                placeholder="Living Room Display"
                required
                autoFocus
              />
            </label>
            <TroubleLine trouble={problem} />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  cancel();
                  setWorking(false);
                  setProblem(undefined);
                  setStep({ name: "code" });
                }}
              >
                Back
              </Button>
              <Button type="submit" disabled={working || !name.trim()}>
                {working ? "Approving…" : "Approve"}
              </Button>
            </DialogFooter>
          </form>
        )}
        {step.name === "done" && (
          <div className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>{step.deviceName} is approved</DialogTitle>
              <DialogDescription>
                It shows the home’s dashboard in a few seconds.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => props.onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TroubleLine(props: { trouble?: Trouble }) {
  const { trouble } = props;
  if (!trouble) return null;
  return "field" in trouble ? (
    <FieldProblem>{trouble.field}</FieldProblem>
  ) : (
    <Problem title={trouble.title}>{trouble.reason}</Problem>
  );
}
