import {
  modelProviders,
  type ModelChoice,
  type ModelProvider,
  type ModelSourceLook,
  type ModelsInfo,
} from "@meetsanctum/app-sdk";
import {
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  SegmentedControl,
} from "@meetsanctum/ui-sdk";
import { Check } from "lucide-react";
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
import { problemText, providerNames, sizeText } from "./words";

// Adding a source of the home's AI model: first where it runs, then a
// computer's address, which Sanctum looks at for Ollama and its models, or a
// provider's key, which Sanctum checks and lists the models of. Adding it
// runs a check, whose answer the page shows.

type Where = "computer" | "provider";
type Found = { models: ModelChoice[]; address?: string };

const help = "m-0 text-[13px] leading-[18px] text-muted-foreground";
const fieldLabel = "text-[13px] font-medium";
const choice =
  "flex cursor-pointer items-start gap-3 rounded-md border-2 border-transparent bg-card px-4 py-3 has-checked:border-primary has-checked:bg-background has-focus-visible:ring-3 has-focus-visible:ring-ring/50";

export function AddSource(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (info: ModelsInfo) => void;
  onCloseAutoFocus: () => void;
}) {
  const [step, setStep] = useState<"where" | Where>("where");
  const [where, setWhere] = useState<Where>("computer");
  const [address, setAddress] = useState("");
  const [computer, setComputer] = useState("");
  const [provider, setProvider] = useState<ModelProvider>("openrouter");
  const [key, setKey] = useState("");
  const [found, setFound] = useState<Found>();
  const [model, setModel] = useState("");
  const [problem, setProblem] = useState<string>();
  const [looking, setLooking] = useState(false);
  const [adding, setAdding] = useState(false);
  const { start, cancel } = useAuthAttempt();
  const ids = {
    address: useId(),
    computer: useId(),
    key: useId(),
    model: useId(),
  };

  useEffect(() => {
    if (!props.open) return;
    cancel();
    setStep("where");
    setWhere("computer");
    setAddress("");
    setComputer("");
    setProvider("openrouter");
    setKey("");
    setFound(undefined);
    setModel("");
    setProblem(undefined);
    setLooking(false);
    setAdding(false);
  }, [props.open, cancel]);

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
        setModel(answer.models[0]!.id);
      }
    } catch {
      if (!signal.aborted) setProblem("That did not work. Try again.");
    } finally {
      if (!signal.aborted) setLooking(false);
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!found || !model || adding) return;
    if (step === "computer" && !computer.trim()) return;
    const signal = start();
    setAdding(true);
    setProblem(undefined);
    try {
      const info = await coreJson<ModelsInfo>("/api/models/sources", {
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
      props.onAdded(info);
      props.onOpenChange(false);
    } catch {
      if (signal.aborted) return;
      setProblem("That did not work. Try again.");
      setAdding(false);
    }
  };

  const status = found && (
    <p
      role="status"
      className="m-0 flex items-center gap-2 text-sm font-medium"
    >
      <Check aria-hidden="true" className="size-4 text-(--leaf-text)" />
      {step === "computer"
        ? `Found Ollama at ${found.address}, with ${found.models.length === 1 ? "1 model" : `${found.models.length} models`}`
        : "The key works"}
    </p>
  );
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
      <NativeSelect
        id={ids.model}
        value={model}
        disabled={adding}
        onChange={(event) => setModel(event.target.value)}
        className="w-full"
      >
        {found.models.map((each) => (
          <NativeSelectOption key={each.id} value={each.id}>
            {each.size ? `${each.name} · ${sizeText(each.size)}` : each.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <p className={help}>
        {step === "computer"
          ? "For another model, run ollama pull on that computer, then check again."
          : `The models your key can use at ${providerNames[provider]}.`}
      </p>
    </div>
  );

  const setOpen = (open: boolean) => {
    if (adding) return;
    if (!open) cancel();
    props.onOpenChange(open);
  };

  return (
    <Dialog open={props.open} onOpenChange={setOpen}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          props.onCloseAutoFocus();
        }}
      >
        {step === "where" && (
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
                Where your home's AI model runs. You can add more than one and
                choose which is in use.
              </DialogDescription>
            </DialogHeader>
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="sr-only">Where it runs</legend>
              <label className={choice}>
                <input
                  type="radio"
                  name="where"
                  checked={where === "computer"}
                  onChange={() => setWhere("computer")}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span className="flex flex-col gap-0.5 leading-tight">
                  <span className="text-sm font-medium">
                    On a computer in your home
                  </span>
                  <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
                    A Mac or PC that runs a local model with Ollama.
                  </span>
                </span>
              </label>
              <label className={choice}>
                <input
                  type="radio"
                  name="where"
                  checked={where === "provider"}
                  onChange={() => setWhere("provider")}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span className="flex flex-col gap-0.5 leading-tight">
                  <span className="text-sm font-medium">
                    With an AI provider
                  </span>
                  <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
                    OpenRouter or OpenAI, with your own API key. Faster, but
                    what's asked leaves your home.
                  </span>
                </span>
              </label>
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

        {step === "computer" && (
          <form className="flex flex-col gap-5" onSubmit={add}>
            <DialogHeader>
              <DialogTitle>A computer in your home</DialogTitle>
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
              <p id={`${ids.address}-help`} className={help}>
                An address on your network, such as 192.168.1.40. Port 11434,
                unless you changed it there: add it as 192.168.1.40:11500.
              </p>
            </div>
            {status}
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
                disabled={!found || !model || !computer.trim() || adding}
              >
                Add and check
              </Button>
            </DialogFooter>
          </form>
        )}

        {step === "provider" && (
          <form className="flex flex-col gap-5" onSubmit={add}>
            <DialogHeader>
              <DialogTitle>An AI provider</DialogTitle>
              <DialogDescription>
                {productName} keeps the key sealed and never shows it again.
              </DialogDescription>
            </DialogHeader>
            <SegmentedControl
              label="Provider"
              options={modelProviders.map((each) => ({
                value: each,
                label: providerNames[each],
              }))}
              value={provider}
              onValueChange={(each) => {
                setProvider(each);
                forget();
              }}
              disabled={adding}
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
                  aria-invalid={!!problem && !found}
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
              <p className={help}>
                From your account at {providerNames[provider]}. Any limit on
                what it spends is set there.
              </p>
            </div>
            {status}
            {models}
            <div className="flex flex-col gap-1 rounded-md bg-card px-4 py-3">
              <span className="text-sm font-medium">
                What goes to {providerNames[provider]}
              </span>
              <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
                A short test question and the description of a test tool.
                {provider === "openrouter" &&
                  " OpenRouter passes it to the company behind the model."}
              </p>
            </div>
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
              <Button type="submit" disabled={!found || !model || adding}>
                Add and check
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
