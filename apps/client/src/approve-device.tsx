import {
  formatPairingCode,
  normalisePairingCode,
  shortPin,
  type PairingRequestInfo,
} from "@meetsanctum/auth-protocol";
import { Button, Input } from "@meetsanctum/ui-sdk";
import { useEffect, useState, type FormEvent } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { productName } from "./brand";
import { CoreError, currentCredential } from "./core-fetch";
import { approvePairing, lookupPairing } from "./auth/pairing";
import { useAuthAttempt } from "./auth/use-auth-attempt";
import { platformNames } from "./platforms";

// The approval screen, on every client: type the code a shared device shows,
// see what asked, name it and approve. Whoever approves compares the short
// pin of this client's host with the one under the device's code: a device
// that sees another certificate is not talking to this host. The device then
// collects its token itself, and joins Settings → Clients.

type Step =
  | { name: "code" }
  | { name: "details"; request: PairingRequestInfo }
  | { name: "done"; deviceName: string };

function problemText(error: unknown) {
  if (error instanceof CoreError) {
    switch (error.code) {
      case "not_found":
        return "No device is showing this code. Check it, or wait for the device's new code.";
      case "invalid_request":
        return "Check the code and the name.";
    }
    return `${productName} ran into a problem. Try again.`;
  }
  return `Can't reach ${productName}. Try again.`;
}

export function ApproveDevice(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApproved: () => void;
}) {
  // None over plain HTTP in development.
  const pin = currentCredential()?.pin ?? null;
  const [step, setStep] = useState<Step>({ name: "code" });
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string>();
  const [working, setWorking] = useState(false);
  const { start, cancel } = useAuthAttempt();

  useEffect(() => {
    cancel();
    if (props.open) {
      setStep({ name: "code" });
      setCode("");
      setProblem(undefined);
      setWorking(false);
    }
  }, [props.open, cancel]);

  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    const signal = start();
    setWorking(true);
    setProblem(undefined);
    try {
      await action(signal);
    } catch (error) {
      if (!signal.aborted) setProblem(problemText(error));
    } finally {
      if (!signal.aborted) setWorking(false);
    }
  };

  const find = (event: FormEvent) => {
    event.preventDefault();
    const normalised = normalisePairingCode(code);
    if (!normalised) {
      setProblem("A code has 8 letters and digits, such as K7QX-M4PD.");
      return;
    }
    void run(async (signal) => {
      const request = await lookupPairing(normalised, signal);
      signal.throwIfAborted();
      setName(request.suggestedName);
      setStep({ name: "details", request });
    });
  };

  const approve = (event: FormEvent) => {
    event.preventDefault();
    if (step.name !== "details") return;
    const deviceName = name.trim();
    void run(async (signal) => {
      await approvePairing(
        { code: step.request.code, name: deviceName },
        signal,
      );
      signal.throwIfAborted();
      setStep({ name: "done", deviceName });
      props.onApproved();
    });
  };

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
          <form onSubmit={find} className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>Add a shared device</DialogTitle>
              <DialogDescription>
                On the tablet or wall display, choose “This is a shared device”.
                Then type the code it shows.
              </DialogDescription>
            </DialogHeader>
            <Input
              aria-label="Code"
              placeholder="K7QX-M4PD"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={12}
              className="h-12 text-center text-2xl font-light tabular-nums md:text-2xl"
              required
              autoFocus
            />
            <Problem text={problem} />
            <DialogFooter>
              <Button type="submit" disabled={working}>
                {working ? "Finding it…" : "Find the device"}
              </Button>
            </DialogFooter>
          </form>
        )}
        {step.name === "details" && (
          <form onSubmit={approve} className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>
                Approve {formatPairingCode(step.request.code)}
              </DialogTitle>
              <DialogDescription>
                {step.request.suggestedName} ·{" "}
                {platformNames[step.request.platform]} · asked from{" "}
                {step.request.address}. It can see and change everything in the
                home, as anyone signed in can.
              </DialogDescription>
            </DialogHeader>
            {pin && (
              <p className="m-0 text-sm">
                Check that the device shows this home certificate:{" "}
                <span className="font-medium tabular-nums">
                  {shortPin(pin)}
                </span>
              </p>
            )}
            <label className="flex flex-col gap-2">
              <span className="text-[13px] font-medium text-muted-foreground">
                Name
              </span>
              <Input
                value={name}
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
                placeholder="Kitchen tablet"
                required
                autoFocus
              />
            </label>
            <Problem text={problem} />
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
                Another code
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
                It signs in by itself within a few seconds and shows the
                household’s dashboard.
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

function Problem(props: { text?: string }) {
  return props.text ? (
    <p role="alert" className="m-0 text-sm text-destructive">
      {props.text}
    </p>
  ) : null;
}
