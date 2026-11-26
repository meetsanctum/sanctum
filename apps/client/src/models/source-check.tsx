import type {
  ModelChoice,
  ModelSourceInfo,
  ModelSourceLook,
} from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import {
  Check,
  CircleAlert,
  CircleCheck,
  Coins,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { useAuthAttempt } from "../auth/use-auth-attempt";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { coreJson } from "../core-fetch";
import { KnotLoader } from "../knot-loader";
import type { ModelsResponse } from "./data";
import { ModelPicker } from "./model-picker";
import {
  checkProblemText,
  problemText,
  providerNames,
  sourceName,
} from "./words";

// A source's check, followed in the dialog that started it: adding a source
// or changing its model or key asks the model a short question, which the
// page's answers follow until it ends. It ends on how it went, what it used
// and what's left to do: Done, Use it now while another source is in use,
// Check again when it didn't answer, or another model when it answered
// without the tool.

type Shown = { kind: "check" } | { kind: "choose" };
type CheckAction = "check" | "use";

const help = "m-0 text-[13px] leading-[18px] font-medium text-muted-foreground";

/** What the check used, as the result says it. */
export function tokensText(tokens: number | undefined) {
  if (tokens === undefined) return undefined;
  if (tokens === 0) return "The check used no tokens";
  return `The check used ${tokens.toLocaleString()} ${tokens === 1 ? "token" : "tokens"}`;
}

/** Whether the source runs in the home, where a first answer can wait for the model to load. */
const inHome = (source: ModelSourceInfo) =>
  source.kind === "sanctum" || source.kind === "computer";

export function SourceCheck(props: {
  source: ModelSourceInfo | undefined;
  // The source in use, when it's another one.
  inUse: ModelSourceInfo | undefined;
  // What was done before the check, such as "Added to your sources".
  done: string;
  onClose: () => void;
  onChanged: (info: ModelsResponse) => void;
}) {
  const { source } = props;
  const [shown, setShown] = useState<Shown>({ kind: "check" });
  const [acting, setActing] = useState(false);
  const [failedAction, setFailedAction] = useState<CheckAction>();

  // Use it now and Check again answer with the whole list, as the page's
  // own buttons do.
  const act = async (action: CheckAction) => {
    if (acting || !source) return;
    setActing(true);
    setFailedAction(undefined);
    try {
      props.onChanged(
        await coreJson<ModelsResponse>(
          `/api/models/sources/${source.id}/${action}`,
          {
            method: "POST",
            signal: AbortSignal.timeout(10_000),
          },
        ),
      );
    } catch {
      setFailedAction(action);
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

  const check = source.check;
  if (source.checking) {
    return (
      <Result
        badge={<KnotLoader className="size-7 text-(--secondary)" />}
        title={`Checking ${source.modelName}`}
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
          <li className="flex items-center gap-2.5">
            <Check aria-hidden="true" className="size-4 text-(--leaf-text)" />
            {props.done}
          </li>
          <li className="flex items-center gap-2.5" aria-current="step">
            {/* The knot above shows it's under way; one loader at a time. */}
            <span
              aria-hidden="true"
              className="mx-0.5 size-3 rounded-full border-[1.5px] border-current"
            />
            Asking it one short question
          </li>
          <li className="flex items-center gap-2.5 text-muted-foreground">
            <span
              aria-hidden="true"
              className="mx-0.5 size-3 rounded-full border-[1.5px] border-current opacity-70"
            />
            Seeing whether it uses the tool
          </li>
        </ol>
        <p className={help}>
          {inHome(source)
            ? "This can take a minute while the model loads."
            : "This takes a few seconds."}{" "}
          If you close this, the check carries on, and AI Models shows how it
          went.
        </p>
      </Result>
    );
  }

  const used = tokensText(check?.tokens);
  const tokens = used && (
    <span className="inline-flex items-center gap-1.5 rounded-sm bg-foreground/8 px-2.5 py-1 text-[13px] leading-[18px] font-medium text-muted-foreground">
      <Coins aria-hidden="true" className="size-3.5" />
      {used}
    </span>
  );

  if (!check || check.outcome === "failed") {
    const lines = [
      check
        ? checkProblemText(check.problem ?? "answer", source)
        : "You can start a new check.",
      "It stays in your sources.",
    ];
    if (!inHome(source)) {
      lines.push("Checking it again uses a few hundred tokens.");
    }
    return (
      <Result
        badge={<CircleAlert className="size-6.5 text-destructive" />}
        title={
          check
            ? `${source.modelName} didn't answer`
            : "The check didn't finish"
        }
        lines={lines}
        tokens={tokens}
        problem={
          failedAction === "check"
            ? "Couldn't start the check. Try again."
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
        title={`${source.modelName} may not work well`}
        lines={[
          "It answered, but didn't use your home's tools, so it may not act on your devices.",
          "A model that supports tools works better.",
        ]}
        tokens={tokens}
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

  const seconds = ((check.firstWordMs ?? 0) / 1000).toFixed(1);
  const lines = [
    source.inUse
      ? "It's now your home's AI model."
      : props.inUse
        ? `Your home still uses ${sourceName(props.inUse)}.`
        : "No source is in use.",
    `It answered in ${seconds} s and used your home's tools.`,
  ];
  // Use it now checks it again, which a provider charges for.
  if (!source.inUse && !inHome(source)) {
    lines.push("Use it now checks it again, which uses a few hundred tokens.");
  }
  return (
    <Result
      badge={<CircleCheck className="size-6.5 text-(--leaf-text)" />}
      title={`${source.modelName} is ready`}
      lines={lines}
      tokens={tokens}
      problem={
        !source.inUse && failedAction === "use"
          ? "Couldn't switch to this source. Try again."
          : undefined
      }
      footer={
        <>
          {!source.inUse && (
            <Button
              variant="outline"
              disabled={acting}
              onClick={() => void act("use")}
            >
              Use it now
            </Button>
          )}
          <Button onClick={props.onClose}>Done</Button>
        </>
      }
    />
  );
}

function Result(props: {
  badge?: ReactNode;
  title: string;
  lines?: string[];
  tokens?: ReactNode;
  children?: ReactNode;
  problem?: string;
  footer: ReactNode;
}) {
  const [first, ...rest] = props.lines ?? [];
  return (
    <div className="flex flex-col gap-6">
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
          <DialogTitle className="text-[17px] leading-6 text-balance">
            {props.title}
          </DialogTitle>
          {first && (
            <DialogDescription className="text-sm font-medium text-foreground">
              {first}
            </DialogDescription>
          )}
          {rest.map((line) => (
            <p key={line} className="m-0 text-sm text-muted-foreground">
              {line}
            </p>
          ))}
        </DialogHeader>
        {props.tokens}
        {props.children}
      </div>
      {props.problem && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {props.problem}
        </p>
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
  const [problem, setProblem] = useState<string>();
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
        if (!look.found) setProblem(problemText(look.problem, source));
        else setModels(look.models.filter((each) => each.id !== source.model));
      })
      .catch(() => {
        if (!signal.aborted) setProblem("That did not work. Try again.");
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
      setProblem(
        (error as { status?: number }).status === 404
          ? problemText("model", source)
          : "That did not work. Try again.",
      );
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
            : `Choose one that can use tools, so it can act on your devices. Checking it uses tokens again, and ${providerNames[source.kind]} charges for them.`}
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
      {problem && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {problem}
        </p>
      )}
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
