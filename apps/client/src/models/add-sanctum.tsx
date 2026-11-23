import type {
  AppInfo,
  AvailableApp,
  ModelChoice,
  ModelSourceLook,
  ModelsInfo,
} from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { Check } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { addProblemOf, Asks, shortfallWords } from "../add-app-sheet";
import { AppIcon } from "../app-icon";
import { productName } from "../brand";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { coreJson } from "../core-fetch";
import { sizeText } from "./words";

// Adding Ollama on Sanctum as a source, in the Add sheet: the Ollama app
// added here when the home hasn't it, with what it needs; while it has no
// model, a way to its page to download one; then a choice of the models it
// has. Nothing opens over the sheet.

export const ollamaAppId = "sanctum.ollama";

type Phase =
  | { kind: "looking" }
  | { kind: "add"; app: AvailableApp | undefined }
  | { kind: "noModel" }
  | { kind: "choose"; models: ModelChoice[] };

const help = "m-0 text-[13px] leading-[18px] text-muted-foreground";
const choice =
  "flex cursor-pointer items-start gap-3 rounded-md border-2 border-transparent bg-card px-4 py-3 has-checked:border-primary has-checked:bg-background has-focus-visible:ring-3 has-focus-visible:ring-ring/50";

export function AddSanctum(props: {
  apps: readonly AppInfo[];
  onBack: () => void;
  onAdded: (info: ModelsInfo) => void;
  onAppAdded: (app: AppInfo) => void;
  // Closes the sheet and opens Ollama's page.
  onOpenOllama: () => void;
  // A request under way, which closing the sheet waits for.
  onBusy: (busy: boolean) => void;
}) {
  const hasOllama = props.apps.some((app) => app.id === ollamaAppId);
  const [phase, setPhase] = useState<Phase>({ kind: "looking" });
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const { onBusy } = props;

  useEffect(() => onBusy(busy), [busy, onBusy]);

  useEffect(() => {
    let isCurrent = true;
    const look = async () => {
      if (!hasOllama) {
        const list = await coreJson<AvailableApp[]>("/api/apps/available")
          .then((each) => (Array.isArray(each) ? each : []))
          .catch(() => []);
        if (isCurrent) {
          setPhase({
            kind: "add",
            app: list.find((app) => app.id === ollamaAppId),
          });
        }
        return;
      }
      const answer = await coreJson<ModelSourceLook>("/api/models/look", {
        method: "POST",
        json: { kind: "sanctum" },
      }).catch(() => undefined);
      if (!isCurrent) return;
      if (answer?.found && answer.models.length > 0) {
        setPhase({ kind: "choose", models: answer.models });
        setModel(answer.models[0]!.id);
      } else {
        setPhase({ kind: "noModel" });
      }
    };
    void look();
    return () => {
      isCurrent = false;
    };
  }, [hasOllama]);

  const addOllama = async () => {
    if (phase.kind !== "add" || !phase.app || busy) return;
    const { app } = phase;
    setBusy(true);
    setProblem(undefined);
    try {
      const added = await coreJson<AppInfo>("/api/apps/add", {
        method: "POST",
        json: { id: app.id, version: app.version },
      });
      props.onAppAdded(added);
      setPhase({ kind: "noModel" });
    } catch (error) {
      setProblem(addProblemOf(error, app));
    } finally {
      setBusy(false);
    }
  };

  const addSource = async (event: FormEvent) => {
    event.preventDefault();
    if (phase.kind !== "choose" || !model || busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      props.onAdded(
        await coreJson<ModelsInfo>("/api/models/sources", {
          method: "POST",
          json: { kind: "sanctum", model },
        }),
      );
    } catch {
      setProblem("That did not work. Try again.");
      setBusy(false);
    }
  };

  const title = <DialogTitle>On {productName}</DialogTitle>;
  const problemLine = problem && (
    <p role="alert" className="m-0 text-sm text-destructive">
      {problem}
    </p>
  );
  const back = (
    <Button
      type="button"
      variant="outline"
      disabled={busy}
      onClick={props.onBack}
    >
      Back
    </Button>
  );

  if (phase.kind === "looking") {
    return (
      <div className="flex flex-col gap-5">
        <DialogHeader>
          {title}
          <DialogDescription>Looking for Ollama</DialogDescription>
        </DialogHeader>
        <DialogFooter>{back}</DialogFooter>
      </div>
    );
  }

  if (phase.kind === "add") {
    const { app } = phase;
    const [short] = app?.shortfalls ?? [];
    const blocked = short && app && shortfallWords(short, app.name);
    return (
      <div className="flex flex-col gap-5">
        <DialogHeader>
          {title}
          <DialogDescription>
            Add the Ollama app, then download a model on its page.
          </DialogDescription>
        </DialogHeader>
        {app ? (
          <>
            <div className="flex items-center gap-3 rounded-md bg-card px-4 py-3">
              {app.icon && <AppIcon icon={app.icon} className="size-10" />}
              <span className="flex min-w-0 flex-col gap-0.5 leading-tight">
                <span className="text-sm font-medium">{app.name}</span>
                {app.summary && (
                  <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
                    {app.summary}
                  </span>
                )}
              </span>
            </div>
            <Asks requests={app.requests.filter((request) => request.needed)} />
            {blocked && (
              <p role="alert" className="m-0 text-sm">
                <span className="font-medium">{blocked.title}</span>{" "}
                {blocked.line}
              </p>
            )}
          </>
        ) : (
          <p className={help}>
            {productName} can't add Ollama now. Close this and look again.
          </p>
        )}
        {problemLine}
        <DialogFooter>
          {back}
          <Button
            type="button"
            disabled={!app || !!blocked || busy}
            onClick={() => void addOllama()}
          >
            Add Ollama
          </Button>
        </DialogFooter>
      </div>
    );
  }

  if (phase.kind === "noModel") {
    return (
      <div className="flex flex-col gap-5">
        <DialogHeader>
          {title}
          <DialogDescription>
            Go to the Ollama app to download a model.
          </DialogDescription>
        </DialogHeader>
        <p
          role="status"
          className="m-0 flex items-center gap-2 text-sm font-medium"
        >
          <Check aria-hidden="true" className="size-4 text-(--leaf-text)" />
          Ollama is added to {productName}
        </p>
        <DialogFooter>
          {back}
          <Button type="button" onClick={props.onOpenOllama}>
            Open Ollama
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={addSource}>
      <DialogHeader>
        {title}
        <DialogDescription>Choose a model.</DialogDescription>
      </DialogHeader>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="sr-only">Model</legend>
        {phase.models.map((each) => (
          <label key={each.id} className={choice}>
            <input
              type="radio"
              name="sanctum-model"
              checked={model === each.id}
              disabled={busy}
              onChange={() => setModel(each.id)}
              className="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <span className="flex flex-col gap-0.5 leading-tight">
              <span className="text-sm font-medium">{each.name}</span>
              <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
                {each.size ? `${each.id} · ${sizeText(each.size)}` : each.id}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className={help}>
        For another model, download it on{" "}
        <Button
          type="button"
          variant="link"
          size="inline"
          onClick={props.onOpenOllama}
        >
          Ollama's page
        </Button>
        .
      </p>
      {problemLine}
      <DialogFooter>
        {back}
        <Button type="submit" disabled={busy || !model}>
          Add and check
        </Button>
      </DialogFooter>
    </form>
  );
}
