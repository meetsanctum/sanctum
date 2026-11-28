import {
  Button,
  defineAppUi,
  icons,
  type LucideIcon,
  PageBar,
  PageSection,
  Problem,
  Switch,
} from "@meetsanctum/ui-sdk";
import { useEffect, useId, useRef, useState } from "react";

import type { OllamaStatus } from "../index";
import { useStatus } from "./use-status";
import {
  downloadLine,
  memoryCapacityLine,
  memoryLine,
  modelLine,
  percentOf,
  processorLine,
  roomHint,
  shareOf,
  storageCapacityLine,
  storageLine,
} from "./words";
import { version } from "../../sanctum-app.json";

// Ollama's page: what this Sanctum has for AI models, the models on it with
// those downloading, and the models it could download, each with a circle
// for how much of the memory free for models it takes and what it needs of
// the memory and storage. A model that's tight or too large says so in
// orange or red, and one too large stays listed with Download off. A
// processor that's likely too slow says so, and its downloads wait until the
// household switches on Download anyway. Removing a model asks first. It's
// the household's, the same on every device.

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
          provider, from Settings → AI Models.
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

type Offer = OllamaStatus["offered"][number];
type CapacityState = NonNullable<Offer["memory"]>["state"];

// Green while it fits, orange when it's tight, red when it's too large.
const ringColour: Record<CapacityState, string> = {
  fits: "text-(--leaf-text)",
  tight: "text-(--sun-text)",
  tooLarge: "text-(--danger)",
};
const labelColour: Record<Exclude<CapacityState, "fits">, string> = {
  tight:
    "text-(--sun-text) bg-[color-mix(in_srgb,var(--sun-text)_12%,transparent)]",
  tooLarge:
    "text-(--danger) bg-[color-mix(in_srgb,var(--danger)_11%,transparent)]",
};

/** How much of the memory free for models a model takes, as a ring. */
function Ring(props: { name: string; memory: Offer["memory"] }) {
  const { memory } = props;
  const radius = 9;
  const length = 2 * Math.PI * radius;
  const share = memory ? shareOf(memory) : 0;
  const label = !memory
    ? `${props.name}: the memory free isn't known`
    : share > 100
      ? `${props.name} needs more memory than is free for models`
      : `${props.name} takes ${share}% of the memory free for models`;
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label={label}
      className={`size-7 shrink-0 ${memory ? ringColour[memory.state] : ""}`}
    >
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        strokeWidth="3.5"
        className="stroke-muted"
      />
      {memory && (
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={`${(length * Math.min(share, 100)) / 100} ${length}`}
          transform="rotate(-90 12 12)"
        />
      )}
    </svg>
  );
}

/** A line of what a model takes: neutral while it fits, a label when not. */
function CapacityLine(props: {
  icon: LucideIcon;
  state: CapacityState;
  text: string;
}) {
  const look =
    props.state === "fits"
      ? "text-muted-foreground"
      : `rounded-xs px-1.5 py-0.5 font-semibold ${labelColour[props.state]}`;
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 self-start text-[13px] leading-[18px] font-medium ${look}`}
    >
      <props.icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0">{props.text}</span>
    </span>
  );
}

function OfferRow(props: {
  offer: Offer;
  canDownload: boolean;
  onDownload: () => void;
}) {
  const { offer } = props;
  const id = `ollama-offer-${offer.id.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <div className={row}>
      <Ring name={offer.name} memory={offer.memory} />
      <span id={`${id}-words`} className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={`${id}-name`} className="text-[15px] leading-5 font-medium">
          {offer.name}
        </span>
        <CapacityLine
          icon={icons.HardDrive}
          state={offer.storage?.state ?? "fits"}
          text={storageCapacityLine(offer.storage, offer.sizeBytes)}
        />
        {offer.memory && (
          <CapacityLine
            icon={icons.MemoryStick}
            state={offer.memory.state}
            text={memoryCapacityLine(offer.memory)}
          />
        )}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={!props.canDownload || !offer.fits}
        aria-describedby={`${id}-words`}
        onClick={props.onDownload}
      >
        Download
      </Button>
    </div>
  );
}

type Refused = { title: string; reason: string; offered?: boolean };

function MainPage() {
  const { status, hasFailed, act } = useStatus();
  const [isAnyway, setIsAnyway] = useState(false);
  // What didn't happen, and what to do.
  // `offered` for a model offered for download, said in that section.
  const [problem, setProblem] = useState<Refused>();

  const run = async (
    action: string,
    input: Record<string, unknown>,
    refused: Refused,
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
          <Problem title="Ollama’s page didn’t load">
            It tries again shortly.
          </Problem>
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
                    {
                      title: `${model.name} wasn’t removed`,
                      reason: "It’s still on Sanctum. Try again in a moment.",
                    },
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
                  {
                    title: `${download.name} didn’t stop downloading`,
                    reason: "Press Stop again in a moment.",
                  },
                )
              }
              onRetry={() =>
                void run(
                  "ollama.download",
                  { model: download.id, anyway: isAnyway },
                  {
                    title: `${download.name} didn’t download`,
                    reason: "Ollama didn’t start it. Try again in a moment.",
                  },
                )
              }
            />
          ))}
          {problem && !problem.offered && (
            <Problem title={problem.title}>{problem.reason}</Problem>
          )}
        </PageSection>
        <div className="flex flex-col gap-2">
          <PageSection
            id="ollama-offered"
            title="Download a model"
            hint={roomHint(status.offered)}
          >
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
                Every model offered here is on this Sanctum.
              </p>
            ) : (
              status.offered.map((offer) => (
                <OfferRow
                  key={offer.id}
                  offer={offer}
                  canDownload={canDownload && status.isAnswering}
                  onDownload={() =>
                    void run(
                      "ollama.download",
                      { model: offer.id, anyway: isAnyway },
                      {
                        title: `${offer.name} didn’t download`,
                        reason:
                          "Ollama didn’t start it. Try again in a moment.",
                        offered: true,
                      },
                    )
                  }
                />
              ))
            )}
            {problem?.offered && (
              <Problem title={problem.title}>{problem.reason}</Problem>
            )}
          </PageSection>
          <p className={note}>
            Models that handle your home’s tools well. The circle shows how much
            of the memory free for models each takes; one that doesn’t fit stays
            listed, with Download off. What’s asked of them stays in your home.
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
