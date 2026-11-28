import type {
  AppInfo,
  ModelChoice,
  ModelSourceInfo,
  ModelSourceLook,
} from "@meetsanctum/app-sdk";
import {
  Button,
  FieldProblem,
  Input,
  Problem,
  type LiveFeed,
  useHomeClock,
} from "@meetsanctum/ui-sdk";
import {
  CircleAlert,
  EllipsisVertical,
  KeyRound,
  Pencil,
  RefreshCw,
  Repeat,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { useAuthAttempt } from "../auth/use-auth-attempt";
import { productName } from "../brand";
import { Section } from "../components";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { coreJson } from "../core-fetch";
import { problemReason } from "../device-parts";
import { AddSource } from "./add-source";
import { ModelPicker } from "./model-picker";
import { SourceCheck, sourceIconOf } from "./source-check";
import { ollamaAppId } from "./add-sanctum";
import { NoModel } from "./no-model";
import { AppsUsing, TokensUsed } from "./usage";
import { useModels, type ModelsResponse } from "./data";
import {
  checkLine,
  modelsTitle,
  problemText,
  sourceDetail,
  sourceName,
  type Place,
} from "./words";

// Settings → AI models: the sources of the home's AI model, the one in use
// first, then the others with Use, each with how its last check went and a
// menu to check it again, rename it, change its model or key, or remove it;
// then the tokens used and the apps that use it (usage.tsx). Add a source
// adds Ollama on Sanctum, or looks at a computer's address or a provider's
// key before adding it; with no source yet, the page offers the places it
// can run instead (no-model.tsx). Every client sees and changes the same.

type Editing = {
  action: "check" | "rename" | "model" | "key" | "remove";
  source: ModelSourceInfo;
  trigger: HTMLButtonElement | null;
};

export function ModelsPage(props: {
  live: LiveFeed;
  page: ReactNode;
  // The home's apps, as the shell has them.
  apps: readonly AppInfo[];
  onAppAdded?: (app: AppInfo) => void;
  // Opens an app's page, as Ollama's.
  onOpenApp?: (appId: string) => void;
}) {
  const { info, hasFailed, refresh, answered } = useModels(props.live);
  const [adding, setAdding] = useState(false);
  // Where Add a source starts, when the empty page asked where it runs, and
  // the choice that opened it, which gets focus back when it closes.
  const [start, setStart] = useState<Place>();
  const opener = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<Editing>();
  const [isActing, setIsActing] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const firstChoice = useRef<HTMLButtonElement>(null);
  const supportsSanctum = info?.usage !== undefined;
  const sources = info?.sources ?? [];
  const isEmpty = info !== undefined && sources.length === 0;
  const inUse = sources.find((source) => source.inUse);
  const others = sources.filter((source) => !source.inUse);
  const hasOllamaPage = props.apps.some(
    (app) => app.id === ollamaAppId && app.pages.length > 0,
  );
  const focusAddSource = () =>
    (addButton.current ?? firstChoice.current)?.focus();

  const act = async (path: string) => {
    if (isActing) return;
    setIsActing(true);
    try {
      answered(
        await coreJson<ModelsResponse>(path, {
          method: "POST",
          signal: AbortSignal.timeout(10_000),
        }),
      );
    } catch {
      void refresh();
    } finally {
      setIsActing(false);
    }
  };
  const row = (source: ModelSourceInfo) => (
    <SourceRow
      key={source.id}
      source={source}
      isActing={isActing}
      onUse={() => void act(`/api/models/sources/${source.id}/use`)}
      onEdit={(action, trigger) => setEditing({ source, action, trigger })}
      onOpenOllama={
        hasOllamaPage && props.onOpenApp
          ? () => props.onOpenApp?.(ollamaAppId)
          : undefined
      }
    />
  );

  return (
    <>
      <Section
        id="settings-models"
        title={modelsTitle}
        // Until the first answer it isn't known whether the home has a
        // source or needs the empty page, so only the bar shows.
        hideBody={info === undefined && !hasFailed}
        action={
          // With no source yet, the empty page's places are the way in.
          sources.length > 0 && (
            <Button
              ref={addButton}
              disabled={isActing}
              onClick={() => {
                setStart(undefined);
                opener.current = null;
                setAdding(true);
              }}
            >
              Add a source
            </Button>
          )
        }
        page={props.page}
      >
        {hasFailed && (
          // As System says it: the page asks again on its own.
          <p
            role="status"
            className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground"
          >
            Couldn't read your AI models. It checks again by itself.
          </p>
        )}
        {isEmpty && (
          <NoModel
            supportsSanctum={supportsSanctum}
            disabled={isActing}
            firstChoiceRef={firstChoice}
            onChoose={(place, button) => {
              setStart(place);
              opener.current = button;
              setAdding(true);
            }}
          />
        )}
        {info && sources.length > 0 && !inUse && (
          <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
            No source is in use. Choose Use beside one below.
          </p>
        )}
        {inUse && (
          <ul className="m-0 flex list-none flex-col p-0">{row(inUse)}</ul>
        )}
      </Section>
      {others.length > 0 && (
        <Section
          id="settings-models-other"
          title="Other Sources"
          // About all of them, so beside their title, not under the last.
          hint={`${productName} never switches on its own`}
        >
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {others.map(row)}
          </ul>
        </Section>
      )}
      {info && sources.length > 0 && (
        <TokensUsed info={info} installed={props.apps} />
      )}
      {info && (sources.length > 0 || info.apps.length > 0) && (
        <AppsUsing
          apps={info.apps}
          installed={props.apps}
          onOpenApp={props.onOpenApp}
        />
      )}
      {info && (
        <>
          <AddSource
            open={adding}
            info={info}
            onOpenChange={setAdding}
            onAdded={answered}
            onCloseAutoFocus={() => {
              if (opener.current?.isConnected) opener.current.focus();
              else focusAddSource();
            }}
            apps={props.apps}
            supportsSanctum={supportsSanctum}
            start={start}
            onAppAdded={props.onAppAdded}
            onOpenApp={props.onOpenApp}
          />
          <EditSource
            editing={editing}
            info={info}
            onClose={() => setEditing(undefined)}
            onDone={answered}
            onFocusFallback={focusAddSource}
          />
        </>
      )}
    </>
  );
}

function CheckStatus(props: { source: ModelSourceInfo }) {
  const clock = useHomeClock();
  const line = checkLine(clock, props.source);
  if (!line) return null;
  return (
    <p
      role="status"
      className="m-0 flex items-start gap-2 text-[13px] leading-[18px] font-medium"
    >
      {line.tone === "problem" && (
        <CircleAlert
          aria-hidden="true"
          className="mt-px size-4 shrink-0 text-destructive"
        />
      )}
      <span className={line.tone === "plain" ? "text-muted-foreground" : ""}>
        {line.text}
      </span>
    </p>
  );
}

function SourceRow(props: {
  source: ModelSourceInfo;
  isActing: boolean;
  onUse: () => void;
  onEdit: (
    action: Editing["action"],
    trigger: HTMLButtonElement | null,
  ) => void;
  // Opens Ollama's page, for Ollama on Sanctum.
  onOpenOllama?: () => void;
}) {
  const { source } = props;
  const name = sourceName(source);
  const detailId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  const Icon = sourceIconOf(source);
  const hasKey = source.kind !== "computer" && source.kind !== "sanctum";
  return (
    <li className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/8"
        >
          <Icon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
          <span className="truncate text-sm font-medium">{name}</span>
          <span
            id={detailId}
            className="text-[13px] leading-[18px] font-medium text-muted-foreground"
          >
            {sourceDetail(source)}
          </span>
        </span>
        {!source.inUse && (
          <Button
            variant="outline"
            size="sm"
            disabled={props.isActing}
            aria-describedby={detailId}
            onClick={props.onUse}
          >
            Use
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={menuButton}
              variant="ghost"
              size="icon-sm"
              disabled={props.isActing}
              aria-label={`${name}: more`}
              aria-describedby={detailId}
            >
              <EllipsisVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              disabled={source.checking}
              onSelect={() => props.onEdit("check", menuButton.current)}
            >
              <RefreshCw />
              Check again
            </DropdownMenuItem>
            {source.kind === "computer" && (
              <DropdownMenuItem
                onSelect={() => props.onEdit("rename", menuButton.current)}
              >
                <Pencil />
                Rename computer
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => props.onEdit("model", menuButton.current)}
            >
              <Repeat />
              Change model
            </DropdownMenuItem>
            {hasKey && (
              <DropdownMenuItem
                onSelect={() => props.onEdit("key", menuButton.current)}
              >
                <KeyRound />
                Replace key
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => props.onEdit("remove", menuButton.current)}
            >
              <Trash2 />
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <CheckStatus source={source} />
      {source.inUse && source.kind === "sanctum" && (
        <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
          Ollama keeps this model loaded, so the first question after a restart
          doesn't wait for it.
          {props.onOpenOllama && (
            <>
              {" "}
              <Button variant="link" size="inline" onClick={props.onOpenOllama}>
                Manage models on Ollama's page
              </Button>
            </>
          )}
        </p>
      )}
    </li>
  );
}

const editTitles: Record<Editing["action"], (name: string) => string> = {
  check: () => "Check again",
  rename: () => "Rename this computer",
  model: () => "Change model",
  key: () => "Replace key",
  remove: (name) => `Remove ${name}?`,
};

// Checking a source again, renaming a computer, changing a source's model or
// a provider's key, or removing a source after saying what that does. A
// check, and the check a new model or key runs, is followed to its result.
function EditSource(props: {
  editing?: Editing;
  // The home's sources as the page has them, for the check a change runs.
  info: ModelsResponse;
  onClose: () => void;
  onDone: (info: ModelsResponse) => void;
  onFocusFallback: () => void;
}) {
  // What the dialog showed stays while it closes.
  const last = useRef<Editing>(undefined);
  if (props.editing) last.current = props.editing;
  const editing = last.current;
  const source = editing?.source;
  const [text, setText] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<ModelChoice[]>();
  const [problem, setProblem] = useState<
    | { kind: "key-refusal"; reason: string }
    | { kind: "failure"; title: string; reason: string }
  >();
  // A source that lists no models has nothing to choose from.
  const [noModels, setNoModels] = useState(false);
  const [working, setWorking] = useState(false);
  const wasRemoved = useRef(false);
  // A new model or key is checked: the dialog follows it to its result.
  const [checked, setChecked] = useState<string>();
  const { start, cancel } = useAuthAttempt();
  const { onDone } = props;
  const action = editing?.action;

  useEffect(() => {
    cancel();
    if (props.editing) wasRemoved.current = false;
    setText(
      props.editing?.action === "rename"
        ? (props.editing.source.computer ?? "")
        : "",
    );
    setModel(props.editing?.source.model ?? "");
    setModels(undefined);
    setProblem(undefined);
    setNoModels(false);
    setWorking(false);
    setChecked(undefined);
    const opened = props.editing;
    if (opened?.action === "check") {
      // Asked at once: the dialog follows the check from its start.
      // It gives up after ten seconds, as the page's other actions do, so
      // the dialog never waits on a core that doesn't answer.
      const controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(10_000),
      ]);
      setWorking(true);
      void coreJson<ModelsResponse>(
        `/api/models/sources/${opened.source.id}/check`,
        { method: "POST", signal },
      )
        .then((info) => {
          if (controller.signal.aborted) return;
          onDone(info);
          setWorking(false);
          setChecked(opened.source.id);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setWorking(false);
          setProblem({
            kind: "failure",
            title: "The check didn't start",
            reason: problemReason(error),
          });
        });
      return () => controller.abort();
    }
    if (opened?.action !== "model") return;
    // Listed again, as a model may have been pulled since; a provider's
    // list needs its key, which only the core holds.
    const controller = new AbortController();
    const { signal } = controller;
    void coreJson<ModelSourceLook>(
      `/api/models/sources/${opened.source.id}/models`,
      { signal },
    )
      .then((look) => {
        if (signal.aborted) return;
        if (!look.found) {
          setProblem({
            kind: "failure",
            title: "Models didn't load",
            reason: problemText(look.problem, opened.source),
          });
        } else if (look.models.length === 0) {
          setNoModels(true);
        } else {
          setModels(look.models);
        }
      })
      .catch((error: unknown) => {
        if (!signal.aborted)
          setProblem({
            kind: "failure",
            title: "Models didn't load",
            reason: problemReason(error),
          });
      });
    return () => controller.abort();
  }, [props.editing, cancel, onDone]);

  const close = () => {
    cancel();
    props.onClose();
  };

  const canSave =
    action === "remove" ||
    (action === "rename" && text.trim() !== "") ||
    (action === "key" && text.trim().length >= 8) ||
    (action === "model" && model !== "" && model !== source?.model);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || !source || working || !canSave) return;
    const signal = start();
    setWorking(true);
    setProblem(undefined);
    const path = `/api/models/sources/${source.id}`;
    try {
      const info = await coreJson<ModelsResponse>(path, {
        method: action === "remove" ? "DELETE" : "PATCH",
        signal,
        ...(action === "remove"
          ? {}
          : {
              json:
                action === "rename"
                  ? { computer: text.trim() }
                  : action === "key"
                    ? { key: text.trim() }
                    : { model },
            }),
      });
      signal.throwIfAborted();
      wasRemoved.current = action === "remove";
      props.onDone(info);
      if (action === "model" || action === "key") {
        setWorking(false);
        setChecked(source.id);
      } else {
        props.onClose();
      }
    } catch (error) {
      if (signal.aborted) return;
      const status = (error as { status?: number }).status;
      setProblem(
        action === "key" && status === 403
          ? { kind: "key-refusal", reason: problemText("key", source) }
          : {
              kind: "failure",
              title:
                action === "rename"
                  ? `${source.computer ?? name} wasn't renamed`
                  : action === "key"
                    ? "The key wasn't replaced"
                    : action === "model"
                      ? "The model wasn't changed"
                      : `${name} wasn't removed`,
              reason:
                action === "model" && status === 404
                  ? problemText("model", source)
                  : problemReason(error),
            },
      );
      setWorking(false);
    }
  };

  const name = source ? sourceName(source) : "";
  return (
    <Dialog
      open={!!props.editing}
      onOpenChange={(open) => {
        if (!open && !working) close();
      }}
    >
      <DialogContent
        showCloseButton={action !== "remove"}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!wasRemoved.current && editing?.trigger?.isConnected)
            editing.trigger.focus();
          else props.onFocusFallback();
        }}
      >
        {checked || (action === "check" && working && source) ? (
          <SourceCheck
            source={
              checked
                ? props.info.sources.find((each) => each.id === checked)
                : source && { ...source, checking: true }
            }
            inUse={props.info.sources.find(
              (each) => each.inUse && each.id !== source?.id,
            )}
            done={
              action === "key"
                ? "Key replaced"
                : action === "model"
                  ? "Model changed"
                  : undefined
            }
            onClose={close}
            onChanged={props.onDone}
          />
        ) : action === "check" ? (
          <div className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>Check again</DialogTitle>
            </DialogHeader>
            {problem?.kind === "failure" && (
              <Problem title={problem.title}>{problem.reason}</Problem>
            )}
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>
                {action ? editTitles[action](name) : ""}
              </DialogTitle>
              <DialogDescription>
                {action === "rename" &&
                  "The name shows here and in the activity log."}
                {action === "model" &&
                  (source?.kind === "sanctum"
                    ? "The models in the Ollama app. For another, download it on Ollama's page."
                    : source?.kind === "computer"
                      ? "The models on that computer. For another, run ollama pull there."
                      : "The models your key can use.")}
                {action === "key" &&
                  `${productName} checks the new key, then stores it encrypted and never shows it again.`}
                {action === "remove" &&
                  (source?.inUse
                    ? "It's the source in use. Its key and tokens go with it. You can choose another source after removing it."
                    : "Its key and the tokens it counted go with it.")}
              </DialogDescription>
            </DialogHeader>
            {action === "rename" && (
              <Input
                aria-label="Computer"
                value={text}
                maxLength={64}
                disabled={working}
                onChange={(event) => setText(event.target.value)}
                required
                autoFocus
              />
            )}
            {action === "key" && (
              <Input
                aria-label="API key"
                type="password"
                autoComplete="off"
                value={text}
                maxLength={512}
                disabled={working}
                onChange={(event) => {
                  setText(event.target.value);
                  if (problem?.kind === "key-refusal") setProblem(undefined);
                }}
                required
                autoFocus
                aria-invalid={problem?.kind === "key-refusal"}
              />
            )}
            {problem?.kind === "key-refusal" && (
              <FieldProblem>{problem.reason}</FieldProblem>
            )}
            {action === "model" && models && (
              <ModelPicker
                aria-label="Model"
                models={models}
                value={model}
                onChange={setModel}
                disabled={working}
              />
            )}
            {action === "model" && noModels && (
              <p className="m-0 text-sm text-muted-foreground">
                This source has no models to choose from.
              </p>
            )}
            {problem?.kind === "failure" && (
              <Problem title={problem.title}>{problem.reason}</Problem>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                autoFocus={action === "remove"}
                disabled={working}
                onClick={close}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant={action === "remove" ? "destructive" : "default"}
                disabled={working || !canSave}
              >
                {action === "remove" ? "Remove" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
