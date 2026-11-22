import type {
  ModelChoice,
  ModelSourceInfo,
  ModelSourceLook,
  ModelsInfo,
} from "@meetsanctum/app-sdk";
import {
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  type LiveFeed,
} from "@meetsanctum/ui-sdk";
import {
  Check,
  CircleAlert,
  Cloud,
  EllipsisVertical,
  KeyRound,
  Laptop,
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
import { Row, Section } from "../components";
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
import { AddSource } from "./add-source";
import { useModels } from "./data";
import {
  checkLine,
  modelsTitle,
  problemText,
  sourceDetail,
  sourceName,
  tokensText,
} from "./words";

// Settings → AI models: the sources of the home's AI model, the one in use
// first, then the others with Use, each with how its last check went and a
// menu to check it again, rename it, change its model or key, or remove it;
// then the tokens each used. Add a source looks at a computer's address or a
// provider's key before adding it. Every client sees and changes the same.

export const modelsSettingsPage = "ai-models";

type Editing = {
  action: "rename" | "model" | "key" | "remove";
  source: ModelSourceInfo;
  trigger: HTMLButtonElement | null;
};

export function ModelsPage(props: { live: LiveFeed; page: ReactNode }) {
  const { info, refresh, answered } = useModels(props.live);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Editing>();
  const addButton = useRef<HTMLButtonElement>(null);
  const sources = info?.sources ?? [];
  const inUse = sources.find((source) => source.inUse);
  const others = sources.filter((source) => !source.inUse);

  const act = async (path: string) => {
    try {
      answered(await coreJson<ModelsInfo>(path, { method: "POST" }));
    } catch {
      void refresh();
    }
  };
  const row = (source: ModelSourceInfo) => (
    <SourceRow
      key={source.id}
      source={source}
      onUse={() => void act(`/api/models/sources/${source.id}/use`)}
      onCheck={() => void act(`/api/models/sources/${source.id}/check`)}
      onEdit={(action, trigger) => setEditing({ source, action, trigger })}
    />
  );

  return (
    <>
      <Section
        id="settings-models"
        title={modelsTitle}
        action={
          <Button ref={addButton} onClick={() => setAdding(true)}>
            Add a source
          </Button>
        }
        page={props.page}
      >
        {info && sources.length === 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">
              Your home has no AI model yet
            </span>
            <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
              Apps that use AI ask your home's model for answers. It can run on
              a computer in your home that runs Ollama, where nothing leaves
              your home, or with an AI provider and your own API key, which is
              faster, but what's asked leaves your home.
            </p>
          </div>
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
        <Section id="settings-models-other" title="Other sources">
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {others.map(row)}
          </ul>
          <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
            Sanctum never switches to another source on its own.
          </p>
        </Section>
      )}
      {sources.length > 0 && (
        <Section id="settings-models-tokens" title="Tokens used">
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {sources.map((source) => (
              <li key={source.id}>
                <Row
                  title={sourceName(source)}
                  detail={tokensText(source.tokens)}
                />
              </li>
            ))}
          </ul>
          <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
            What a provider charges, and any limit on it, is set with that
            provider.
          </p>
        </Section>
      )}
      <AddSource
        open={adding}
        onOpenChange={setAdding}
        onAdded={answered}
        onCloseAutoFocus={() => addButton.current?.focus()}
      />
      <EditSource
        editing={editing}
        onClose={() => setEditing(undefined)}
        onDone={answered}
        onFocusFallback={() => addButton.current?.focus()}
      />
    </>
  );
}

function CheckStatus(props: { source: ModelSourceInfo }) {
  const line = checkLine(props.source);
  if (!line) return null;
  return (
    <p
      role="status"
      className="m-0 flex items-start gap-2 text-[13px] leading-[18px] font-medium"
    >
      {line.tone === "good" && (
        <Check
          aria-hidden="true"
          className="mt-px size-4 shrink-0 text-(--leaf-text)"
        />
      )}
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
  onUse: () => void;
  onCheck: () => void;
  onEdit: (
    action: Editing["action"],
    trigger: HTMLButtonElement | null,
  ) => void;
}) {
  const { source } = props;
  const name = sourceName(source);
  const detailId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  const Icon = source.kind === "computer" ? Laptop : Cloud;
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
              aria-label={`${name}: more`}
              aria-describedby={detailId}
            >
              <EllipsisVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              disabled={source.checking}
              onSelect={props.onCheck}
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
            {source.kind !== "computer" && (
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
    </li>
  );
}

const editTitles: Record<Editing["action"], (name: string) => string> = {
  rename: () => "Rename this computer",
  model: () => "Change model",
  key: () => "Replace key",
  remove: (name) => `Remove ${name}?`,
};

// Renaming a computer, changing a source's model or a provider's key, or
// removing a source after saying what that does.
function EditSource(props: {
  editing?: Editing;
  onClose: () => void;
  onDone: (info: ModelsInfo) => void;
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
  const [problem, setProblem] = useState<string>();
  const [working, setWorking] = useState(false);
  const wasRemoved = useRef(false);
  const { start, cancel } = useAuthAttempt();
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
    setWorking(false);
    const opened = props.editing;
    if (opened?.action !== "model") return;
    // Listed again, as a model may have been pulled since; a provider's
    // list needs its key, which only the core holds.
    const signal = start();
    void coreJson<ModelSourceLook>(
      `/api/models/sources/${opened.source.id}/models`,
      { signal },
    )
      .then((look) => {
        if (signal.aborted) return;
        if (look.found) setModels(look.models);
        else setProblem(problemText(look.problem, opened.source));
      })
      .catch(() => {
        if (!signal.aborted) setProblem("That did not work. Try again.");
      });
  }, [props.editing, cancel, start]);

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
      const info = await coreJson<ModelsInfo>(path, {
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
      props.onClose();
    } catch (error) {
      if (signal.aborted) return;
      const status = (error as { status?: number }).status;
      setProblem(
        action === "key" && status === 403
          ? problemText("key", source)
          : status === 404
            ? problemText("model", source)
            : "That did not work. Try again.",
      );
      setWorking(false);
    }
  };

  const name = source ? sourceName(source) : "";
  return (
    <Dialog
      open={!!props.editing}
      onOpenChange={(open) => {
        if (!open) close();
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
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>{action ? editTitles[action](name) : ""}</DialogTitle>
            <DialogDescription>
              {action === "rename" &&
                "The name shows here and in the activity log."}
              {action === "model" &&
                (source?.kind === "computer"
                  ? "The models on that computer. For another, run ollama pull there."
                  : "The models your key can use.")}
              {action === "key" &&
                "Sanctum checks the new key, then keeps it sealed and never shows it again."}
              {action === "remove" &&
                (source?.inUse
                  ? "It's the source in use: apps that use AI get no answer until you use another. Its key and tokens go with it."
                  : "Its key and the tokens it counted go with it.")}
            </DialogDescription>
          </DialogHeader>
          {action === "rename" && (
            <Input
              aria-label="Computer"
              value={text}
              maxLength={64}
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
              onChange={(event) => setText(event.target.value)}
              required
              autoFocus
            />
          )}
          {action === "model" && models && (
            <NativeSelect
              aria-label="Model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="w-full"
            >
              {models.map((choice) => (
                <NativeSelectOption key={choice.id} value={choice.id}>
                  {choice.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
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
              autoFocus={action === "remove"}
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
      </DialogContent>
    </Dialog>
  );
}
