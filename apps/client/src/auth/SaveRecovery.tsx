import { formatInviteCode } from "@meetsanctum/auth-protocol";
import { Button, useHomeClock } from "@meetsanctum/ui-sdk";
import { Copy, KeyRound, Printer } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { makeInvite } from "../people/invites";
import { printRecoveryCode } from "../people/print-recovery";
import { PairingCode } from "./pairing-code";
import { Sheet, SheetActions, SheetStatus } from "./sheet";
import { useAuthAttempt } from "./use-auth-attempt";

// Right after setting up a home, the first person saves a recovery code: if
// they forget their password, it lets them choose a new one, even when no
// device is signed in as them and no one else signs in. This device makes
// it and shows it once, to copy or print. Continue never waits on it: the
// code can be made again on their page.

type Made = { code: string; madeAt: string };

export function SaveRecovery(props: {
  personId: string;
  person: string;
  username: string;
  onContinue: () => void;
}) {
  const clock = useHomeClock();
  const attempt = useAuthAttempt();
  const [made, setMade] = useState<Made>();
  const [failed, setFailed] = useState(false);
  const [copy, setCopy] = useState<"copied" | "failed">();
  const codeText = useRef<HTMLSpanElement>(null);
  const { personId } = props;

  useEffect(() => {
    const signal = attempt.start();
    makeInvite({ personId, kind: "recovery" }, signal).then(
      (invite) => {
        if (!signal.aborted)
          setMade({ code: invite.code, madeAt: invite.info.createdAt });
      },
      () => {
        if (!signal.aborted) setFailed(true);
      },
    );
    return () => attempt.cancel();
    // Once, for the person the home was just set up with.
  }, [personId]);

  const formatted = made ? formatInviteCode(made.code) : "";
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(formatted);
      setCopy("copied");
    } catch {
      setCopy("failed");
      if (codeText.current)
        window.getSelection()?.selectAllChildren(codeText.current);
    }
  };

  return (
    <Sheet
      glyph={KeyRound}
      title="Save a recovery code"
      subtitle="If you forget your password, this code lets you choose a new one. It works once."
    >
      <div className="flex flex-col gap-5">
        {!made && !failed && <SheetStatus>Making a code…</SheetStatus>}
        {failed && (
          <p className="m-0 text-center text-[15px] leading-[21px] text-balance">
            The code couldn’t be made. You can make one on your page in Settings
            → People.
          </p>
        )}
        {made && (
          <>
            <div className="flex flex-col items-center gap-2">
              <PairingCode code={made.code} />
              {/* The boxes show it; the text is for screen readers, and for
                  copying by hand if Copy code fails. */}
              <p
                className={
                  copy === "failed"
                    ? "m-0 text-sm tracking-wider select-all"
                    : "sr-only"
                }
              >
                <span className="sr-only">The code is </span>
                <span ref={codeText}>{formatted}</span>
              </p>
            </div>
            <p className="m-0 text-center text-[15px] leading-[21px] text-balance">
              Save it in a password manager, or print it and keep it with your
              important papers.
            </p>
            <div className="flex justify-center gap-2">
              <Button variant="outline" onClick={() => void copyCode()}>
                <Copy data-icon="inline-start" aria-hidden="true" />
                {copy === "copied" ? "Copied" : "Copy code"}
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  printRecoveryCode({
                    clock,
                    person: props.person,
                    username: props.username,
                    code: formatted,
                    madeAt: made.madeAt,
                  })
                }
              >
                <Printer data-icon="inline-start" aria-hidden="true" />
                Print
              </Button>
            </div>
            <p role="status" className="sr-only">
              {copy === "copied" ? "Copied" : ""}
            </p>
            {copy === "failed" && (
              <p className="m-0 text-center text-sm text-muted-foreground">
                Couldn’t copy the code. Copy it manually from the text above.
              </p>
            )}
          </>
        )}
        <SheetActions>
          <Button
            variant="default"
            size="lg"
            className="w-full"
            disabled={!made && !failed}
            onClick={props.onContinue}
          >
            Continue
          </Button>
          <p className="m-0 text-center text-[13px] leading-[18px] text-balance text-muted-foreground">
            You can make a new code any time on your page in Settings → People.
          </p>
        </SheetActions>
      </div>
    </Sheet>
  );
}
