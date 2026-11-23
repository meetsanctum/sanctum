import {
  Button,
  PageBar,
  PageSection,
  Switch,
  defineAppUi,
  icons,
} from "@meetsanctum/ui-sdk";
import { useEffect, useId, useRef, useState } from "react";

import type { OllamaStatus } from "../index";
import { useStatus } from "./use-status";
import {
  downloadLine,
  memoryLine,
  modelLine,
  percentOf,
  processorLine,
  storageLine,
} from "./words";
import { version } from "../../sanctum-app.json";

// Ollama's page: what this Sanctum has for AI models, the models on it with
// those downloading, and the models it could download. A processor that's
// likely too slow says so, and its downloads wait until the household ticks
// Download anyway; models that don't fit the memory and storage left aren't
// offered. Removing a model asks first. It's the household's, the same on
// every device.

const note =
  "m-0 px-1 text-[13px] leading-[18px] font-medium text-muted-foreground";
const row = "flex min-h-14 items-center gap-3 rounded-sm px-2.5 py-2";

function Words(props: { id: string; name: string; line: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span
        id={`${props.id}-name`}
        className="text-[15px] leading-5 font-medium"
      >
        {props.name}
      </span>
      <span
        id={`${props.id}-line`}
        className="text-[13px] leading-[18px] text-muted-foreground"
      >
        {props.line}
      </span>
    </span>
  );
}

function Check(props: { isGood: boolean; text: string }) {
  const Icon = props.isGood ? icons.Check : icons.CircleAlert;
  return (
    <li className="flex items-start gap-2 text-[13px] leading-[18px] font-medium">
      <Icon
        aria-hidden="true"
        className={`mt-px size-4 shrink-0 ${props.isGood ? "text-(--leaf-text)" : "text-(--danger)"}`}
      />
      <span>{props.text}</span>
    </li>
  );
}

function ThisSanctum({ host }: { host: OllamaStatus["host"] }) {
  const memory = memoryLine(host);
  const storage = storageLine(host);
  return (
    <PageSection id="ollama-host" title="This Sanctum">
      <ul className="m-0 flex list-none flex-col gap-2 px-2.5 py-2">
        <Check
          isGood={!host.processor.isLikelySlow}
          text={processorLine(host)}
        />
        {memory && <Check isGood text={memory} />}
        {storage && <Check isGood text={storage} />}
      </ul>
      {host.processor.isLikelySlow && (
        <p className="m-0 px-2.5 pb-2 text-[13px] leading-[18px] font-medium text-muted-foreground">
          For quicker answers, use Ollama on a computer in your home, or an AI
          provider, from Settings → AI models.
        </p>
      )}
    </PageSection>
  );
}

function ModelRow(props: {
  model: OllamaStatus["models"][number];
  onRemove: () => Promise<void>;
}) {
  const { model } = props;
  const [isConfirming, setIsConfirming] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const id = useId();
  const removeButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (!isConfirming && wasConfirming.current) removeButton.current?.focus();
    wasConfirming.current = isConfirming;
  }, [isConfirming]);
  const remove = async () => {
    setIsBusy(true);
    await props.onRemove();
    setIsBusy(false);
    setIsConfirming(false);
  };
  return (
    <div className="flex flex-col">
      <div className={row}>
        <Words id={id} name={model.name} line={modelLine(model)} />
        {!isConfirming && (
          <Button
            ref={removeButton}
            variant="outline"
            size="sm"
            aria-describedby={`${id}-name`}
            onClick={() => setIsConfirming(true)}
          >
            Remove
          </Button>
        )}
      </div>
      {isConfirming && (
        <div className="flex flex-wrap items-center gap-2 px-2.5 pb-2">
          <span className="text-[13px] font-medium text-muted-foreground">
            Remove {model.name}? Downloading it again takes a while.
          </span>
          <Button
            variant="destructive"
            size="sm"
            disabled={isBusy}
            onClick={() => void remove()}
          >
            Remove
          </Button>
          <Button
            autoFocus
            variant="ghost"
            size="sm"
            disabled={isBusy}
            onClick={() => setIsConfirming(false)}
          >
            Keep it
          </Button>
        </div>
      )}
    </div>
  );
}

function DownloadRow(props: {
  download: OllamaStatus["downloads"][number];
  onStop: () => void;
  onRetry: () => void;
  canRetry: boolean;
}) {
  const { download } = props;
  const id = useId();
  return (
    <div className="flex flex-col gap-1 pb-2">
      <div className={row}>
        <Words id={id} name={download.name} line={downloadLine(download)} />
        {download.problem && (
          <Button
            variant="outline"
            size="sm"
            disabled={!props.canRetry}
            aria-describedby={`${id}-name`}
            onClick={props.onRetry}
          >
            Try again
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          aria-describedby={`${id}-name`}
          onClick={props.onStop}
        >
          {download.problem ? "Cancel" : "Stop download"}
        </Button>
      </div>
      {!download.problem && (
        <div
          className="mx-2.5 h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={`Downloading ${download.name}`}
          aria-describedby={`${id}-line`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentOf(download)}
        >
          <span
            className="block h-full origin-left rounded-full bg-foreground transition-transform"
            style={{ transform: `scaleX(${percentOf(download) / 100})` }}
          />
        </div>
      )}
    </div>
  );
}

function MainPage() {
  const { status, hasFailed, act } = useStatus();
  const [isAnyway, setIsAnyway] = useState(false);
  const [problem, setProblem] = useState<string>();

  const run = async (
    action: string,
    input: Record<string, unknown>,
    refused: string,
  ) => {
    setProblem(undefined);
    const isDone = await act(action, input);
    if (!isDone) setProblem(refused);
  };

  if (!status) {
    return (
      <>
        <PageBar title="Ollama" />
        {hasFailed && (
          <p className={note}>
            Ollama’s page couldn’t load. It tries again shortly.
          </p>
        )}
      </>
    );
  }

  const isSlow = status.host.processor.isLikelySlow;
  const canDownload = !isSlow || isAnyway;
  return (
    <>
      <PageBar title="Ollama" />
      <div className="flex w-full max-w-160 flex-col gap-6">
        <ThisSanctum host={status.host} />
        {problem && (
          <p
            role="alert"
            className="m-0 text-[13px] font-medium text-(--danger)"
          >
            {problem}
          </p>
        )}
        <PageSection id="ollama-models" title="Models on Sanctum">
          {!status.isAnswering ? (
            <p className={`${note} px-2.5 py-2`}>
              Ollama isn’t answering. Its models show here once it answers.
            </p>
          ) : status.models.length === 0 && status.downloads.length === 0 ? (
            <p className={`${note} px-2.5 py-2`}>None yet.</p>
          ) : (
            status.models.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                onRemove={() =>
                  run(
                    "ollama.remove",
                    { model: model.id },
                    `Couldn’t remove ${model.name}. Try again.`,
                  )
                }
              />
            ))
          )}
          {status.downloads.map((download) => (
            <DownloadRow
              key={download.id}
              download={download}
              canRetry={canDownload && status.isAnswering}
              onStop={() =>
                void run(
                  "ollama.stop",
                  { model: download.id },
                  `Couldn’t stop downloading ${download.name}.`,
                )
              }
              onRetry={() =>
                void run(
                  "ollama.download",
                  { model: download.id, anyway: isAnyway },
                  `Couldn’t download ${download.name}. Try again.`,
                )
              }
            />
          ))}
        </PageSection>
        <div className="flex flex-col gap-2">
          <PageSection id="ollama-offered" title="Download a model">
            {isSlow && (
              <div className={row}>
                <Words
                  id="ollama-anyway"
                  name="Download anyway"
                  line="Answers on this Sanctum will be slow."
                />
                <Switch
                  checked={isAnyway}
                  aria-labelledby="ollama-anyway-name"
                  aria-describedby="ollama-anyway-line"
                  onCheckedChange={setIsAnyway}
                />
              </div>
            )}
            {!status.host.memory || !status.host.storage ? (
              <p className={`${note} px-2.5 py-2`}>
                Couldn’t check the memory and storage available for downloads.
              </p>
            ) : status.offered.length === 0 ? (
              <p className={`${note} px-2.5 py-2`}>
                No other model fits the memory and storage this Sanctum has
                free.
              </p>
            ) : (
              status.offered.map((model) => {
                const id = `ollama-offer-${model.id.replace(/[^a-z0-9]/gi, "-")}`;
                return (
                  <div key={model.id} className={row}>
                    <Words id={id} name={model.name} line={modelLine(model)} />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canDownload || !status.isAnswering}
                      aria-describedby={`${id}-name`}
                      onClick={() =>
                        void run(
                          "ollama.download",
                          { model: model.id, anyway: isAnyway },
                          `Couldn’t download ${model.name}. Try again.`,
                        )
                      }
                    >
                      Download
                    </Button>
                  </div>
                );
              })
            )}
          </PageSection>
          <p className={note}>
            Models that handle your home’s tools well, sized for this Sanctum.
            What’s asked of them stays in your home.
          </p>
        </div>
      </div>
    </>
  );
}

export default defineAppUi({
  id: "sanctum.ollama",
  version,
  pages: { main: MainPage },
});
