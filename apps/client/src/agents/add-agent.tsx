import {
  permissionWords,
  type AiCanUse,
  type AppInfo,
} from "@meetsanctum/app-sdk";
import {
  agentSetupCommand,
  type AgentSetupStarted,
  type AgentSetupStatus,
} from "@meetsanctum/auth-protocol";
import { Button, Input } from "@meetsanctum/ui-sdk";
import { Copy, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { productName } from "../brand";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { CoreError, coreJson } from "../core-fetch";
import { canUseTitle } from "./can-use-page";

// Adding an AI agent: a name, with everything AI agents can use named under
// On and Off until you switch them on, then Continue starts a one-time setup
// and shows the prompt to paste into the agent, good for 10 minutes. The
// sheet watches the setup until the agent's connector has made its first
// call, then names the agent and where it connected from, so it can be told
// apart from another of the same name. While the prompt is needed Copy
// prompt is the primary action; once the agent has connected, Done is.
// Closing the sheet leaves the setup running, so an agent pasted into just
// before still connects and shows in the list.

const watchEvery = 1_500;

type Step =
  | { kind: "name" }
  | {
      kind: "prompt";
      name: string;
      setupId: string;
      code: string;
      byHand: boolean;
    }
  | { kind: "connected"; name: string; address: string; connectedAt: string }
  | { kind: "ended"; name: string; status: "expired" | "failed" | "cancelled" };

/** What a setup's prompt says to the agent. */
export function promptText(code: string) {
  return `Connect to my ${productName} home. Run \`${agentSetupCommand(code)}\` and do what it says.`;
}

const endedWords = {
  expired: {
    title: "The prompt has run out",
    description: (name: string) =>
      `${name} didn't connect within 10 minutes. Make a new prompt and paste it in again.`,
  },
  failed: {
    title: "The prompt has stopped working",
    description: () =>
      `Wrong codes were tried with it too often, so ${productName} stopped it. Make a new prompt and paste it in again.`,
  },
  cancelled: {
    title: "The prompt was cancelled",
    description: (name: string) => `Make a new prompt to add ${name}.`,
  },
} as const;

function startProblem(error: unknown) {
  if (error instanceof CoreError && error.code === "busy") {
    return "Several agents are being added already. Wait a few minutes and try again.";
  }
  return "That did not work. Try again.";
}

export function AddAgent(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apps: readonly AppInfo[];
  canUse: AiCanUse | undefined;
  // The agent connected, so the list can show it.
  onConnected: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "name" });
  const [name, setName] = useState("");
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string>();
  // The latest, so watching doesn't start again each time the list renders.
  const onConnected = useRef(props.onConnected);
  onConnected.current = props.onConnected;

  // Each time the sheet opens it starts again from the name.
  useEffect(() => {
    if (!props.open) return;
    setStep({ kind: "name" });
    setName("");
    setWorking(false);
    setProblem(undefined);
  }, [props.open]);

  const start = async (agentName: string) => {
    setWorking(true);
    setProblem(undefined);
    try {
      const started = await coreJson<AgentSetupStarted>(
        "/api/auth/agents/setup",
        { method: "POST", json: { name: agentName } },
      );
      setStep({
        kind: "prompt",
        name: agentName,
        setupId: started.setupId,
        code: started.code,
        byHand: false,
      });
    } catch (error) {
      setProblem(startProblem(error));
    } finally {
      setWorking(false);
    }
  };

  // Watching the setup while the sheet is open and the prompt is needed.
  const setupId = step.kind === "prompt" ? step.setupId : undefined;
  useEffect(() => {
    if (!props.open || !setupId) return;
    let stopped = false;
    const watch = async () => {
      let status: AgentSetupStatus;
      try {
        status = await coreJson<AgentSetupStatus>(
          `/api/auth/agents/setup/${encodeURIComponent(setupId)}`,
        );
      } catch (error) {
        // A setup the core no longer has has run out; anything else, the
        // next turn asks again.
        if (error instanceof CoreError && error.code === "not_found") {
          status = { status: "expired", name: "" };
        } else {
          return;
        }
      }
      if (stopped) return;
      if (status.status === "connected") {
        setStep({
          kind: "connected",
          name: status.agent.name,
          address: status.address,
          connectedAt: status.connectedAt,
        });
        onConnected.current();
      } else if (status.status !== "waiting") {
        setStep((current) => ({
          kind: "ended",
          name: current.kind === "prompt" ? current.name : status.name,
          status: status.status,
        }));
      }
    };
    const timer = window.setInterval(() => void watch(), watchEvery);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [props.open, setupId]);

  const close = () => props.onOpenChange(false);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        {step.kind === "name" && (
          <NameStep
            name={name}
            onName={setName}
            apps={props.apps}
            canUse={props.canUse}
            working={working}
            problem={problem}
            onCancel={close}
            onContinue={() => void start(name.trim())}
          />
        )}
        {step.kind === "prompt" && (
          <PromptStep
            step={step}
            onByHand={(byHand) => setStep({ ...step, byHand })}
            onDone={close}
          />
        )}
        {step.kind === "connected" && (
          <>
            <DialogHeader>
              <DialogTitle>{step.name} is connected</DialogTitle>
              <DialogDescription>
                It connected from {step.address} at{" "}
                {new Date(step.connectedAt).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                . It can use what's on in {canUseTitle}.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button autoFocus onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
        {step.kind === "ended" && (
          <>
            <DialogHeader>
              <DialogTitle>{endedWords[step.status].title}</DialogTitle>
              <DialogDescription>
                {endedWords[step.status].description(step.name)}
              </DialogDescription>
            </DialogHeader>
            {problem && (
              <p role="alert" className="m-0 text-sm text-destructive">
                {problem}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button disabled={working} onClick={() => void start(step.name)}>
                Make a new prompt
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// The name, and everything AI agents can use, in Settings' order and words.
function NameStep(props: {
  name: string;
  onName: (name: string) => void;
  apps: readonly AppInfo[];
  canUse: AiCanUse | undefined;
  working: boolean;
  problem?: string;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (props.name.trim()) props.onContinue();
  };
  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col gap-5">
      <DialogHeader>
        <DialogTitle>Add an agent</DialogTitle>
        <DialogDescription>
          An agent is an AI program on a computer at home, such as Claude Code
          or Codex.
        </DialogDescription>
      </DialogHeader>
      <label className="flex flex-col gap-1.5 text-[13px] font-medium">
        Name
        <Input
          value={props.name}
          maxLength={60}
          placeholder="Codex on the office Mac"
          onChange={(event) => props.onName(event.target.value)}
          required
          autoFocus
        />
      </label>
      {props.canUse && (
        <div className="flex min-h-0 flex-col gap-1.5">
          <span className="text-[13px] font-medium">{canUseTitle}</span>
          <CanUseList apps={props.apps} canUse={props.canUse} />
          <span className="text-[13px] leading-[18px] text-muted-foreground">
            Change any of these in Settings, under {canUseTitle}.
          </span>
        </div>
      )}
      {props.problem && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {props.problem}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={props.working || !props.name.trim()}>
          Continue
        </Button>
      </DialogFooter>
    </form>
  );
}

// What's on, then what's off, each the core's areas first and then each
// app's items under its name. It scrolls, and the buttons stay in view.
function CanUseList(props: { apps: readonly AppInfo[]; canUse: AiCanUse }) {
  const group = (on: boolean) => {
    const areas = props.canUse.areas
      .filter((area) => area.on === on)
      .map((area) => permissionWords(area.id).title);
    const apps = props.apps.flatMap((app) => {
      const titles = props.canUse.offers
        .filter((offer) => offer.app === app.id && offer.on === on)
        .map((offer) => offer.title);
      return titles.length ? [{ app, titles }] : [];
    });
    if (areas.length === 0 && apps.length === 0) return null;
    const items = (titles: string[]) => (
      <ul
        className={`m-0 flex list-none flex-col gap-1 p-0 text-sm font-medium ${on ? "" : "text-muted-foreground"}`}
      >
        {titles.map((title) => (
          <li key={title}>{title}</li>
        ))}
      </ul>
    );
    return (
      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-[13px] font-semibold text-muted-foreground">
          {on ? "On" : "Off until you switch them on"}
        </h3>
        {items(areas)}
        {apps.map(({ app, titles }) => (
          <div key={app.id} className="flex flex-col gap-1">
            <h4 className="m-0 text-[13px] font-semibold">{app.name}</h4>
            {items(titles)}
          </div>
        ))}
      </div>
    );
  };
  return (
    <div
      tabIndex={0}
      aria-label={canUseTitle}
      className="flex max-h-[min(22rem,40vh)] flex-col gap-4 overflow-y-auto rounded-md bg-card px-3.5 py-3 text-card-foreground"
    >
      {group(true)}
      {group(false)}
    </div>
  );
}

// The prompt to paste into the agent, or the command to run by hand, while
// the sheet waits for the agent to connect.
function PromptStep(props: {
  step: Extract<Step, { kind: "prompt" }>;
  onByHand: (byHand: boolean) => void;
  onDone: () => void;
}) {
  const { step } = props;
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const shown = useRef<HTMLParagraphElement>(null);
  const text = step.byHand
    ? agentSetupCommand(step.code)
    : promptText(step.code);

  useEffect(() => {
    setCopied(false);
    setCopyFailed(false);
  }, [step.byHand]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      // Where the clipboard is out of reach, the words are selected to copy
      // by hand.
      setCopyFailed(true);
      const selection = window.getSelection();
      if (shown.current && selection) {
        selection.selectAllChildren(shown.current);
      }
    }
  };

  const copyLabel = step.byHand ? "Copy command" : "Copy prompt";
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {step.byHand ? "Set it up by hand" : `Connect ${step.name}`}
        </DialogTitle>
        <DialogDescription>
          {step.byHand
            ? "For an agent that can't run commands. Run this yourself in a terminal on that computer:"
            : `Copy this prompt and paste it into the agent on that computer. ${productName} shows here when it has connected.`}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <p
          ref={shown}
          className={`m-0 rounded-md bg-card px-4 py-3.5 text-card-foreground [overflow-wrap:anywhere] select-text ${step.byHand ? "font-mono text-[13px] leading-5" : "text-sm leading-[21px]"}`}
        >
          {text}
        </p>
        <span className="text-[13px] leading-[18px] text-muted-foreground">
          {step.byHand
            ? "It works once, for the next 10 minutes. It sets up the connector and shows the commands that add it to your agent, with nothing secret in them."
            : "The prompt works once, for the next 10 minutes."}
        </span>
        {copyFailed && (
          <p role="alert" className="m-0 text-sm text-destructive">
            It couldn't be copied. It's selected: copy it with your keyboard.
          </p>
        )}
      </div>
      <p
        role="status"
        className="m-0 flex items-center gap-2 text-[13px] font-medium text-muted-foreground"
      >
        <LoaderCircle
          aria-hidden="true"
          className="size-4 shrink-0 animate-spin"
        />
        Waiting for {step.name} to connect
      </p>
      <DialogFooter>
        {step.byHand ? (
          <Button variant="outline" onClick={() => props.onByHand(false)}>
            Back
          </Button>
        ) : (
          <>
            <Button
              variant="link"
              size="inline"
              className="sm:me-auto sm:self-center"
              onClick={() => props.onByHand(true)}
            >
              Set it up by hand
            </Button>
            <Button variant="outline" onClick={props.onDone}>
              Done
            </Button>
          </>
        )}
        <Button onClick={() => void copy()}>
          <Copy data-icon="inline-start" aria-hidden="true" />
          {copied ? "Copied" : copyLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
