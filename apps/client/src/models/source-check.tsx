import type {
  ModelCheck,
  ModelChoice,
  ModelSourceInfo,
  ModelSourceLook,
} from "@meetsanctum/app-sdk";
import { Button, Problem } from "@meetsanctum/ui-sdk";
import {
  Check,
  Circle,
  CircleAlert,
  CircleCheck,
  Cloud,
  Cpu,
  Laptop,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { number } from "@meetsanctum/app-sdk/words";

import { useAuthAttempt } from "../auth/use-auth-attempt";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { coreJson } from "../core-fetch";
import { problemReason } from "../device-parts";
import type { ModelsResponse } from "./data";
import { ModelPicker } from "./model-picker";
import {
  checkCostText,
  checkProblemText,
  otherName,
  ownName,
  problemText,
} from "./words";

// A source's check, followed in the dialog that started it: adding a source,
// changing its model or key, switching to it or checking it again asks the
// model a short question, which the page's answers follow until it ends.
// Each step stays on screen for at least two seconds, so the household sees
// that it's checked, however fast the answer. It ends on how it went, in one
// line of facts, and what's left to do: Done, a switch while another source
// is in use, Check again when it didn't answer, or another model when it
// answered without the tool.

type Shown = { kind: "check" } | { kind: "choose" };
type CheckAction = "check" | "use";
// The steps shown while a check runs, and after it until each has had its
// time on screen.
type Step = "idle" | "asking" | "seeing" | "done";

const stepMs = 2_000;

const help = "m-0 text-[13px] leading-[18px] font-medium text-muted-foreground";

/** What a check found, in one line: "Answered in 1.0 s · used 169 tokens". */
export function factsText(check: ModelCheck) {
  const answered =
    check.outcome !== "failed" && check.firstWordMs !== undefined
      ? `Answered in ${(check.firstWordMs / 1000).toFixed(1)} s`
      : undefined;
  const tokens = check.tokens
    ? `${answered ? "used" : "Used"} ${number("en", check.tokens)} ${check.tokens === 1 ? "token" : "tokens"}`
    : undefined;
  return [answered, tokens].filter(Boolean).join(" · ") || undefined;
}

/** Whether the source runs in the home, where a first answer can wait for the model to load. */
const inHome = (source: ModelSourceInfo) =>
  source.kind === "sanctum" || source.kind === "computer";

// Asking stays on screen for at least two seconds each time a check starts.
// Only a check that got an answer shows the tool step.
function useSteps(running: boolean, answered: boolean) {
  const [wasRunning, setWasRunning] = useState(running);
  const [progress, setProgress] = useState<{ step: Step; elapsed?: boolean }>({
    step: running ? "asking" : "idle",
  });
  if (wasRunning !== running) {
    setWasRunning(running);
    if (running) setProgress({ step: "asking" });
  }
  if (progress.step === "asking" && progress.elapsed && !running) {
    setProgress({ step: answered ? "seeing" : "done" });
  }
  useEffect(() => {
    if (
      progress.elapsed ||
      (progress.step !== "asking" && progress.step !== "seeing")
    )
      return;
    const timer = setTimeout(() => {
      setProgress(
        progress.step === "asking"
          ? { step: "asking", elapsed: true }
          : { step: "done" },
      );
    }, stepMs);
    return () => clearTimeout(timer);
  }, [progress]);
  return progress.step;
}

export function SourceCheck(props: {
  source: ModelSourceInfo | undefined;
  // The source in use, when it's another one.
  inUse: ModelSourceInfo | undefined;
  // What was done before the check, such as "Added to your sources";
  // nothing when the check is all there is.
  done?: string;
  onClose: () => void;
  onChanged: (info: ModelsResponse) => void;
}) {
  const { source } = props;
  const check = source?.check;
  const [shown, setShown] = useState<Shown>({ kind: "check" });
  const [acting, setActing] = useState(false);
  // The action that didn't go through, and why.
  const [failed, setFailed] = useState<{
    action: CheckAction;
    reason: string;
  }>();
  // What was done before the check that's under way: the dialog's own
  // change, or a switch; Check again has nothing before it.
  const [done, setDone] = useState<string | undefined>(props.done);
  const step = useSteps(
    !!source?.checking,
    !!check && check.outcome !== "failed",
  );

  // The switch and Check again answer with the whole list, as the page's
  // own buttons do.
  const act = async (action: CheckAction) => {
    if (acting || !source) return;
    setActing(true);
    setFailed(undefined);
    try {
      const info = await coreJson<ModelsResponse>(
        `/api/models/sources/${source.id}/${action}`,
        { method: "POST", signal: AbortSignal.timeout(10_000) },
      );
      setDone(action === "use" ? "Now your home's AI model" : undefined);
      props.onChanged(info);
    } catch (error) {
      setFailed({ action, reason: problemReason(error) });
    } finally {
      setActing(false);
    }
  };

  if (!source) {
    return (
      <Result
        title="This source was removed"
        footer={<Button onClick={props.onClose}>Done</Button>}
      />
    );
  }

  if (shown.kind === "choose") {
    return (
      <ChooseModel
        source={source}
        onBack={() => setShown({ kind: "check" })}
        onChanged={(info) => {
          props.onChanged(info);
          setShown({ kind: "check" });
        }}
      />
    );
  }

  // One name throughout, with its maker where another model shares it.
  const name = ownName(source, props.inUse);
  if (source.checking || step === "asking" || step === "seeing") {
    const isSeeing = step === "seeing";
    return (
      <Result
        // What's being checked, as its row shows it; the step below turns.
        badge={<SourceIcon source={source} />}
        title={`Checking ${name}`}
        footer={
          <Button variant="outline" onClick={props.onClose}>
            Close
          </Button>
        }
      >
        <ol
          aria-label="Steps"
          className="m-0 flex w-full list-none flex-col gap-2 rounded-md bg-card px-4 py-3 text-start text-sm font-medium"
        >
          {done && <DoneStep>{done}</DoneStep>}
          {isSeeing ? (
            <DoneStep>Asked it one short question</DoneStep>
          ) : (
            <CurrentStep>Asking it one short question</CurrentStep>
          )}
          {isSeeing ? (
            <CurrentStep>Seeing whether it uses the tool</CurrentStep>
          ) : (
            <li className="flex items-center gap-2.5 text-muted-foreground">
              <Circle aria-hidden="true" className="size-4 opacity-70" />
              Seeing whether it uses the tool
            </li>
          )}
        </ol>
        {source.checking && (
          <p className={help}>
            {inHome(source)
              ? "This can take a minute while the model loads."
              : "This takes a few seconds."}{" "}
            If you close this, the check carries on. AI Models shows any
            problems it finds.
          </p>
        )}
      </Result>
    );
  }

  const facts = check && factsText(check);

  if (!check || check.outcome === "failed") {
    return (
      <Result
        badge={<CircleAlert className="size-6.5 text-destructive" />}
        title={check ? `${name} didn't answer` : "The check didn't finish"}
        line={
          check
            ? checkProblemText(check.problem ?? "answer", source)
            : "You can start a new check."
        }
        facts={facts}
        problem={
          failed?.action === "check"
            ? { title: "The check didn't start", reason: failed.reason }
            : undefined
        }
        footer={
          <>
            <Button variant="outline" onClick={props.onClose}>
              Done
            </Button>
            <Button disabled={acting} onClick={() => void act("check")}>
              Check again
            </Button>
          </>
        }
      />
    );
  }

  if (check.outcome === "noTool") {
    return (
      <Result
        badge={<TriangleAlert className="size-6 text-(--sun-text)" />}
        title={`${name} may not act on your devices`}
        line="It answered but didn't use the tool. A model that supports tools works better."
        facts={facts}
        footer={
          <>
            <Button variant="outline" onClick={props.onClose}>
              Keep it
            </Button>
            <Button onClick={() => setShown({ kind: "choose" })}>
              Choose another model
            </Button>
          </>
        }
      />
    );
  }

  return (
    <Result
      badge={<CircleCheck className="size-6.5 text-(--leaf-text)" />}
      title={`${name} is ready`}
      line={
        source.inUse
          ? "It's now your home's AI model."
          : props.inUse
            ? `Your home still uses ${otherName(props.inUse, source)}.`
            : "No source is in use."
      }
      facts={facts}
      problem={
        !source.inUse && failed?.action === "use"
          ? {
              title: `Your home didn't switch to ${name}`,
              reason: failed.reason,
            }
          : undefined
      }
      footer={
        <>
          {!source.inUse && (
            <div className="grid min-w-0 grid-cols-1">
              <Button
                variant="outline"
                disabled={acting}
                onClick={() => void act("use")}
              >
                <span className="truncate">Switch to {name}</span>
              </Button>
            </div>
          )}
          <Button onClick={props.onClose}>Done</Button>
        </>
      }
    />
  );
}

function DoneStep(props: { children: ReactNode }) {
  return (
    <li className="flex items-center gap-2.5">
      <Check aria-hidden="true" className="size-4 text-(--leaf-text)" />
      {props.children}
    </li>
  );
}

/** A source's icon, as its row and its check show it. */
export function sourceIconOf(source: ModelSourceInfo) {
  return source.kind === "sanctum"
    ? Cpu
    : source.kind === "computer"
      ? Laptop
      : Cloud;
}

function SourceIcon(props: { source: ModelSourceInfo }) {
  const Icon = sourceIconOf(props.source);
  return <Icon className="size-6" />;
}

function CurrentStep(props: { children: ReactNode }) {
  return (
    <li className="flex items-center gap-2.5" aria-current="step">
      {/* The step under way turns; still under Reduce motion. */}
      <LoaderCircle
        aria-hidden="true"
        className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
      />
      {props.children}
    </li>
  );
}

function Result(props: {
  badge?: ReactNode;
  title: string;
  // Where things stand, in one line.
  line?: string;
  // What the check found, in a quieter one.
  facts?: string;
  children?: ReactNode;
  problem?: { title: string; reason: string };
  footer: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div
        role="status"
        className="flex flex-col items-center gap-3.5 pt-3 text-center"
      >
        {props.badge && (
          <span
            aria-hidden="true"
            className="flex size-12 items-center justify-center rounded-lg bg-foreground/8"
          >
            {props.badge}
          </span>
        )}
        <DialogHeader className="items-center gap-1.5 text-center">
          <DialogTitle className="text-[17px] leading-6 text-balance wrap-anywhere">
            {props.title}
          </DialogTitle>
          {props.line && (
            <DialogDescription className="text-sm text-pretty wrap-anywhere text-foreground">
              {props.line}
            </DialogDescription>
          )}
          {props.facts && (
            <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
              {props.facts}
            </p>
          )}
        </DialogHeader>
        {props.children}
      </div>
      {props.problem && (
        <Problem title={props.problem.title}>{props.problem.reason}</Problem>
      )}
      <DialogFooter>{props.footer}</DialogFooter>
    </div>
  );
}

// Another model for a source that answered without the tool: its list,
// asked for again, and the change, which checks it again.
function ChooseModel(props: {
  source: ModelSourceInfo;
  onBack: () => void;
  onChanged: (info: ModelsResponse) => void;
}) {
  // The source as the result had it: the page's answers keep coming while
  // this is open.
  const [source] = useState(props.source);
  const [models, setModels] = useState<ModelChoice[]>();
  const [model, setModel] = useState("");
  const [problem, setProblem] = useState<{ title: string; reason: string }>();
  const [working, setWorking] = useState(false);
  const { start, cancel } = useAuthAttempt();

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void coreJson<ModelSourceLook>(`/api/models/sources/${source.id}/models`, {
      signal,
    })
      .then((look) => {
        if (signal.aborted) return;
        if (!look.found)
          setProblem({
            title: "Models didn't load",
            reason: problemText(look.problem, source),
          });
        else setModels(look.models.filter((each) => each.id !== source.model));
      })
      .catch((error: unknown) => {
        if (!signal.aborted)
          setProblem({
            title: "Models didn't load",
            reason: problemReason(error),
          });
      });
    return () => {
      controller.abort();
      cancel();
    };
  }, [source, cancel]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!model || working) return;
    const signal = start();
    setWorking(true);
    setProblem(undefined);
    try {
      const info = await coreJson<ModelsResponse>(
        `/api/models/sources/${source.id}`,
        { method: "PATCH", signal, json: { model } },
      );
      signal.throwIfAborted();
      props.onChanged(info);
    } catch (error) {
      if (signal.aborted) return;
      setProblem({
        title: "The model wasn't changed",
        reason:
          (error as { status?: number }).status === 404
            ? problemText("model", source)
            : problemReason(error),
      });
      setWorking(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>Choose another model</DialogTitle>
        <DialogDescription>
          {source.kind === "computer" || source.kind === "sanctum"
            ? "Choose one that can use tools, so it can act on your devices."
            : checkCostText}
        </DialogDescription>
      </DialogHeader>
      {models && models.length > 0 && (
        <ModelPicker
          aria-label="Model"
          models={models}
          value={model}
          onChange={setModel}
          disabled={working}
        />
      )}
      {models?.length === 0 && (
        <p className={help}>
          This source has no other models to choose from.{" "}
          {source.kind === "computer"
            ? "For another, run ollama pull on that computer."
            : source.kind === "sanctum"
              ? "For another, download it on Ollama's page."
              : null}
        </p>
      )}
      {problem && <Problem title={problem.title}>{problem.reason}</Problem>}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={working}
          onClick={props.onBack}
        >
          Back
        </Button>
        <Button type="submit" disabled={!model || working}>
          Change and check
        </Button>
      </DialogFooter>
    </form>
  );
}
