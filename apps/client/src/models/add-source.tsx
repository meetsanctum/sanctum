import {
  modelProviders,
  type ModelChoice,
  type ModelProvider,
  type ModelSourceLook,
  type AppInfo,
} from "@meetsanctum/app-sdk";
import { Button, Input, SegmentedControl } from "@meetsanctum/ui-sdk";
import { CircleCheck } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";

import { useAuthAttempt } from "../auth/use-auth-attempt";
import { productName } from "../brand";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { coreJson } from "../core-fetch";
import { AddSanctum, ollamaAppId } from "./add-sanctum";
import type { AddSourceResponse, ModelsResponse } from "./data";
import { ModelPicker } from "./model-picker";
import { SourceCheck } from "./source-check";
import {
  availablePlaces,
  checkTokensText,
  placeDetails,
  placeNames,
  placePrivacy,
  problemText,
  providerNames,
  type Place,
} from "./words";

// Adding a source of the home's AI model: first where it runs, then Ollama
// on Sanctum (add-sanctum.tsx), a computer's address, which Sanctum looks at
// for Ollama and its models, or a provider's key, which Sanctum checks and
// lists the models of. Adding it runs a check, which the dialog follows to
// its result (source-check.tsx), with the tokens it used.

type Where = Place;
type Found = { models: ModelChoice[]; address?: string };

const help = "m-0 text-[13px] leading-[18px] text-muted-foreground";
const fieldLabel = "text-[13px] font-medium";
const cardLine =
  "m-0 text-[13px] leading-[18px] font-medium text-muted-foreground";
const choice =
  "flex cursor-pointer items-start gap-3 rounded-md border-2 border-transparent bg-card px-4 py-3 has-checked:border-primary has-checked:bg-background has-focus-visible:ring-3 has-focus-visible:ring-ring/50";
const providerOptions = modelProviders.map((value) => ({
  value,
  label: providerNames[value],
}));

export function AddSource(props: {
  open: boolean;
  // The home's sources as the page has them, which its answers keep up to
  // date while a check runs.
  info: ModelsResponse;
  onOpenChange: (open: boolean) => void;
  onAdded: (info: ModelsResponse) => void;
  onCloseAutoFocus: () => void;
  // The home's apps, as the shell has them, for whether Ollama is there.
  apps: readonly AppInfo[];
  supportsSanctum: boolean;
  // Where to start, when the page already asked where it runs; otherwise
  // the dialog asks first.
  start?: Where;
  onAppAdded?: (app: AppInfo) => void;
  // Opens an app's page, as Ollama's.
  onOpenApp?: (appId: string) => void;
}) {
  const [step, setStep] = useState<"where" | Where>("where");
  const places = availablePlaces(props.supportsSanctum);
  const defaultSource = places[0];
  const [where, setWhere] = useState<Where>(defaultSource);
  const [address, setAddress] = useState("");
  const [computer, setComputer] = useState("");
  const [provider, setProvider] = useState<ModelProvider>("openrouter");
  const [key, setKey] = useState("");
  const [found, setFound] = useState<Found>();
  const [model, setModel] = useState("");
  const [problem, setProblem] = useState<string>();
  const [looking, setLooking] = useState(false);
  const [adding, setAdding] = useState(false);
  // The source just added, whose check the dialog follows.
  const [added, setAdded] = useState<string>();
  const { start, cancel } = useAuthAttempt();
  const canAdd =
    model !== "" &&
    found?.models.some((choice) => choice.id === model) === true;
  const ids = {
    address: useId(),
    computer: useId(),
    key: useId(),
    model: useId(),
  };

  useEffect(() => {
    if (!props.open) return;
    cancel();
    setStep(props.start ?? "where");
    setWhere(props.start ?? defaultSource);
    setAddress("");
    setComputer("");
    setProvider("openrouter");
    setKey("");
    setFound(undefined);
    setModel("");
    setProblem(undefined);
    setLooking(false);
    setAdding(false);
    setAdded(undefined);
  }, [props.open, props.start, defaultSource, cancel]);

  // What was found is for what was typed: typing again asks again.
  const forget = () => {
    cancel();
    setFound(undefined);
    setModel("");
    setProblem(undefined);
    setLooking(false);
  };

  const look = async () => {
    if (looking || adding) return;
    const signal = start();
    setLooking(true);
    setProblem(undefined);
    setFound(undefined);
    const kind = step === "computer" ? "computer" : provider;
    try {
      const answer = await coreJson<ModelSourceLook>("/api/models/look", {
        method: "POST",
        signal,
        json:
          kind === "computer"
            ? { kind, address: address.trim() }
            : { kind, key: key.trim() },
      });
      if (signal.aborted) return;
      setModel((selected) =>
        selected &&
        answer.found &&
        answer.models.some((choice) => choice.id === selected)
          ? selected
          : "",
      );
      if (!answer.found) {
        setProblem(
          problemText(answer.problem, {
            kind,
            address: answer.address ?? address.trim(),
          }),
        );
      } else if (answer.models.length === 0) {
        setProblem(
          kind === "computer"
            ? "Ollama answered, but has no local models. Run ollama pull on that computer, then check again."
            : `${providerNames[kind]} lists no models for this key.`,
        );
      } else {
        setFound({ models: answer.models, address: answer.address });
      }
    } catch {
      if (!signal.aborted) setProblem("That did not work. Try again.");
    } finally {
      if (!signal.aborted) setLooking(false);
    }
  };

  // The dialog stays open on the new source's check, which its id finds in
  // the page's answers.
  const showCheck = (info: AddSourceResponse, before: ReadonlySet<string>) => {
    let id = info.addedSourceId;
    if (id === undefined) {
      const unfamiliar = info.sources.filter(
        (source) => !before.has(source.id),
      );
      if (unfamiliar.length === 1) id = unfamiliar[0]?.id;
    }
    props.onAdded(info);
    setAdding(false);
    if (id) setAdded(id);
    else props.onOpenChange(false);
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!found || !canAdd || adding) return;
    if (step === "computer" && !computer.trim()) return;
    const before = new Set(props.info.sources.map((source) => source.id));
    const signal = start();
    setAdding(true);
    setProblem(undefined);
    try {
      const info = await coreJson<AddSourceResponse>("/api/models/sources", {
        method: "POST",
        signal,
        json:
          step === "computer"
            ? {
                kind: "computer",
                address: found.address ?? address.trim(),
                computer: computer.trim(),
                model,
              }
            : { kind: provider, key: key.trim(), model },
      });
      signal.throwIfAborted();
      showCheck(info, before);
    } catch {
      if (signal.aborted) return;
      setProblem("That did not work. Try again.");
      setAdding(false);
    }
  };

  const count = (models: number) =>
    models === 1 ? "1 model" : `${models} models`;
  // What the check found, under the field it checked: where the eye is
  // after pressing Check.
  const status = found && (
    <p role="status" className="m-0 flex items-start gap-2 text-sm font-medium">
      <CircleCheck
        aria-hidden="true"
        className="mt-px size-4.5 shrink-0 fill-(--leaf-text) text-background"
      />
      {step === "computer"
        ? `Found Ollama at ${found.address}, with ${count(found.models.length)}.`
        : `The key works. It can use ${count(found.models.length)}.`}
    </p>
  );
  const foundEdge = found ? "border-(--leaf-text)/60" : undefined;
  const problemLine = problem && (
    <p role="alert" className="m-0 text-sm text-destructive">
      {problem}
    </p>
  );
  const models = found && (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={ids.model} className={fieldLabel}>
        Model
      </label>
      <ModelPicker
        id={ids.model}
        aria-describedby={step === "computer" ? `${ids.model}-help` : undefined}
        models={found.models}
        value={model}
        onChange={setModel}
        disabled={adding}
      />
      {/* A provider lists only models that can use the tool, so there is
          nothing to say there; a computer has only what was pulled. */}
      {step === "computer" && (
        <p id={`${ids.model}-help`} className={help}>
          For another model, run ollama pull on that computer, then check again.
        </p>
      )}
    </div>
  );
  // What pressing Add and check does, and what it costs, right above it.
  const checkCard = (
    <div className="flex flex-col gap-1 rounded-md bg-card px-4 py-3">
      <span className="text-sm font-medium">Adding it runs a check</span>
      <p className={cardLine}>
        {productName} asks the model one short question to see that it answers
        and can use your home's tools.
      </p>
      {step === "provider" && (
        <p className={cardLine}>
          It uses {checkTokensText}, which {providerNames[provider]} charges
          for.
        </p>
      )}
      {step === "provider" && provider === "openrouter" && (
        <p className={cardLine}>
          OpenRouter passes the question to the company behind the model.
        </p>
      )}
      {step === "provider" && provider === "anthropic" && (
        <p className={cardLine}>
          Anthropic keeps the start of a conversation for a few minutes to
          answer faster.
        </p>
      )}
    </div>
  );
  const addedSource = added
    ? props.info.sources.find((source) => source.id === added)
    : undefined;

  const setOpen = (open: boolean) => {
    if (adding) return;
    if (!open) cancel();
    props.onOpenChange(open);
  };

  return (
    <Dialog open={props.open} onOpenChange={setOpen}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          props.onCloseAutoFocus();
        }}
      >
        {added ? (
          <SourceCheck
            source={addedSource}
            inUse={props.info.sources.find(
              (source) => source.inUse && source.id !== added,
            )}
            done="Added to your sources"
            onClose={() => props.onOpenChange(false)}
            onChanged={props.onAdded}
          />
        ) : null}

        {!added && step === "where" && (
          <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              setStep(where);
            }}
          >
            <DialogHeader>
              <DialogTitle>Add a source</DialogTitle>
              <DialogDescription>
                Choose where your home's AI model runs. If you add more than
                one, you choose which one is in use.
              </DialogDescription>
            </DialogHeader>
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="sr-only">Where it runs</legend>
              {places.map((place) => (
                <label key={place} className={choice}>
                  <input
                    type="radio"
                    name="where"
                    checked={where === place}
                    onChange={() => setWhere(place)}
                    className="mt-0.5 size-4 shrink-0 accent-primary"
                  />
                  <span className="flex flex-col gap-0.5 leading-tight">
                    <span className="text-sm font-medium">
                      {placeNames[place]}
                    </span>
                    <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
                      {placeDetails[place]} {placePrivacy[place]}.
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit">Continue</Button>
            </DialogFooter>
          </form>
        )}

        {!added && step === "sanctum" && (
          <AddSanctum
            apps={props.apps}
            onBack={() => setStep("where")}
            onAdded={(info) =>
              showCheck(
                info,
                new Set(props.info.sources.map((source) => source.id)),
              )
            }
            onAppAdded={(app) => props.onAppAdded?.(app)}
            onOpenOllama={
              props.onOpenApp &&
              (() => {
                props.onOpenChange(false);
                props.onOpenApp?.(ollamaAppId);
              })
            }
            busy={adding}
            onBusy={setAdding}
          />
        )}

        {!added && step === "computer" && (
          <form className="flex flex-col gap-5" onSubmit={add}>
            <DialogHeader>
              <DialogTitle>Add a computer in your home</DialogTitle>
              <DialogDescription>
                Install Ollama on that computer and let it listen on your
                network, then enter its address.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.address} className={fieldLabel}>
                Address
              </label>
              <div className="flex gap-2">
                <Input
                  id={ids.address}
                  value={address}
                  inputMode="url"
                  autoComplete="off"
                  maxLength={260}
                  disabled={adding}
                  autoFocus
                  aria-describedby={`${ids.address}-help`}
                  aria-invalid={!!problem && !found}
                  className={foundEdge}
                  onChange={(event) => {
                    setAddress(event.target.value);
                    forget();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !found) {
                      event.preventDefault();
                      if (address.trim() && !looking) void look();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={!address.trim() || looking || adding}
                  onClick={() => void look()}
                >
                  {problem && !found ? "Check again" : "Check"}
                </Button>
              </div>
              {status}
              <p id={`${ids.address}-help`} className={help}>
                An address on your network, such as 192.168.1.40. Port 11434,
                unless you changed it there: add it as 192.168.1.40:11500.
              </p>
            </div>
            {found && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.computer} className={fieldLabel}>
                  Computer
                </label>
                <Input
                  id={ids.computer}
                  value={computer}
                  placeholder="Office Mac"
                  maxLength={64}
                  disabled={adding}
                  onChange={(event) => setComputer(event.target.value)}
                  required
                />
              </div>
            )}
            {models}
            {checkCard}
            {problemLine}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={adding}
                onClick={() => {
                  forget();
                  setStep("where");
                }}
              >
                Back
              </Button>
              <Button
                type="submit"
                disabled={!canAdd || !computer.trim() || adding}
              >
                Add and check
              </Button>
            </DialogFooter>
          </form>
        )}

        {!added && step === "provider" && (
          <form className="flex flex-col gap-5" onSubmit={add}>
            <DialogHeader>
              <DialogTitle>Add an AI provider</DialogTitle>
              <DialogDescription>
                Your home's AI model runs at the provider, with your own API
                key.
              </DialogDescription>
            </DialogHeader>
            <SegmentedControl
              label="Provider"
              options={providerOptions}
              value={provider}
              onValueChange={(each) => {
                if (each === provider) return;
                setProvider(each);
                setKey("");
                forget();
              }}
              disabled={adding}
              phoneMenu
              className="self-start"
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.key} className={fieldLabel}>
                API key
              </label>
              <div className="flex gap-2">
                <Input
                  id={ids.key}
                  type="password"
                  value={key}
                  autoComplete="off"
                  maxLength={512}
                  disabled={adding}
                  autoFocus
                  aria-describedby={`${ids.key}-help`}
                  aria-invalid={!!problem && !found}
                  className={foundEdge}
                  onChange={(event) => {
                    setKey(event.target.value);
                    forget();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !found) {
                      event.preventDefault();
                      if (key.trim().length >= 8 && !looking) void look();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={key.trim().length < 8 || looking || adding}
                  onClick={() => void look()}
                >
                  Check key
                </Button>
              </div>
              {status}
              <p id={`${ids.key}-help`} className={help}>
                Create one in your {providerNames[provider]} account, where you
                can also set a spending limit. {productName} stores it encrypted
                and never shows it again.
              </p>
            </div>
            {models}
            {checkCard}
            {problemLine}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={adding}
                onClick={() => {
                  forget();
                  setStep("where");
                }}
              >
                Back
              </Button>
              <Button type="submit" disabled={!canAdd || adding}>
                Add and check
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
