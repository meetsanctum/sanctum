import { Button } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { productName } from "./brand";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { CoreError, coreJson } from "./core-fetch";
import { formatBytes, serviceNames } from "./system-status";

// Free up space, the Storage card's last row on Status: what it would free
// and what goes, asked first, naming what stays: the version running, the
// one before it, which a rollback needs, and on the dev channel the newest
// build. It then says so in place, with what the disk freed, until Status
// closes. With nothing to free the row says so, its button dimmed.

/** What GET /api/system/space answers. */
export type SpacePlan = {
  bytes: number;
  images: Array<{ service: string; version: string | null }>;
  devBuilds: number;
  keeps: { running: string; before: string | null; newest: string | null };
};

type State =
  | { at: "counting" }
  | { at: "counted"; plan: SpacePlan }
  | { at: "unknown" }
  | { at: "freeing"; plan: SpacePlan }
  | { at: "freed"; plan: SpacePlan; freed: number | null }
  | { at: "failed"; plan: SpacePlan; reason: string };

// Sanctum's parts and its services as people know them.
const groupOf = (service: string) =>
  service === "core" || service === "manager"
    ? productName
    : (serviceNames[service] ?? service);

const andList = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** What goes: "11 dev builds and an old version of Zigbee". */
export function whatGoes(plan: SpacePlan) {
  const versions = new Map<string, Set<string>>();
  for (const image of plan.images) {
    const group = groupOf(image.service);
    const seen = versions.get(group) ?? new Set();
    seen.add(image.version ?? `${image.service}-${seen.size}`);
    versions.set(group, seen);
  }
  return andList([
    ...(plan.devBuilds === 0
      ? []
      : [
          plan.devBuilds === 1 ? "a dev build" : `${plan.devBuilds} dev builds`,
        ]),
    ...[...versions].map(([group, seen]) =>
      seen.size === 1
        ? `an old version of ${group}`
        : `${seen.size} old versions of ${group}`,
    ),
  ]);
}

/** What stays, in the dialog's words. */
export function whatStays(plan: SpacePlan) {
  const { running, before, newest } = plan.keeps;
  const kept = [
    `${running}, which is running`,
    ...(before && before !== running
      ? [`${before} before it, to go back to`]
      : []),
    ...(newest && newest !== running && newest !== before
      ? [`${newest}, the newest, to update to`]
      : []),
  ];
  // Each says something with a comma, so the last comes after one too.
  return `Keeps ${
    kept.length === 1
      ? kept[0]
      : `${kept.slice(0, -1).join(", ")}, and ${kept.at(-1)}`
  }.`;
}

const nothingLeft = (plan: SpacePlan) =>
  !plan.keeps.before
    ? "The rest is kept to go back to"
    : plan.keeps.newest && plan.keeps.newest !== plan.keeps.running
      ? "Only the version running, the one before and the newest are kept"
      : "Only this version and the one before are kept";

function reasonOf(error: unknown) {
  const code = error instanceof CoreError ? error.code : undefined;
  if (code === "busy")
    return "An update or another change is under way. Try again once it has finished";
  if (code === "manager_unavailable") {
    return "Updates and services isn't answering. Try again in a minute";
  }
  return `${productName} didn't answer. Try again in a moment`;
}

/** What Free up space would do, asked when Status opens and again after it frees. */
export function useSpace() {
  const [state, setState] = useState<State>({ at: "counting" });
  const count = useCallback(async () => {
    try {
      const plan = await coreJson<SpacePlan>("/api/system/space");
      setState((current) =>
        current.at === "freed" || current.at === "freeing"
          ? current
          : { at: "counted", plan },
      );
    } catch {
      setState((current) =>
        current.at === "counting" ? { at: "unknown" } : current,
      );
    }
  }, []);
  useEffect(() => void count(), [count]);
  useEffect(() => {
    if (state.at !== "unknown") return;
    const timer = setInterval(() => void count(), 5_000);
    return () => clearInterval(timer);
  }, [count, state.at]);

  const free = async (plan: SpacePlan) => {
    setState({ at: "freeing", plan });
    try {
      const { freed } = await coreJson<{ freed: number | null }>(
        "/api/system/space/free",
        { method: "POST" },
      );
      setState({ at: "freed", plan, freed });
    } catch (error) {
      setState({ at: "failed", plan, reason: reasonOf(error) });
    }
  };
  return { state, free };
}

export type Space = ReturnType<typeof useSpace>;

/** Whether there is something to free now, which a problem's fix needs. */
export const hasSpaceToFree = ({ state }: Space) =>
  (state.at === "counted" || state.at === "failed") && state.plan.bytes > 0;

/** Free up space as a button, asked first: the row's, and the fix of storage almost full. */
export function FreeUpButton(props: { space: Space }) {
  const { state, free } = props.space;
  const [asking, setAsking] = useState(false);
  const plan = "plan" in state ? state.plan : null;
  const canFree = hasSpaceToFree(props.space);
  return (
    <>
      <Button
        variant="outline"
        disabled={!canFree}
        className="shrink-0"
        onClick={() => setAsking(true)}
      >
        {state.at === "freeing" && (
          <LoaderCircle aria-hidden="true" className="animate-spin" />
        )}
        Free up space
      </Button>
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              Free up about {formatBytes(plan?.bytes ?? 0)}?
            </DialogTitle>
            <DialogDescription>
              {plan && `Removes ${whatGoes(plan)}. ${whatStays(plan)}`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              onClick={() => {
                setAsking(false);
                if (plan) void free(plan);
              }}
            >
              Free up space
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The Storage card's last row. */
export function OldVersionsRow(props: { space: Space }) {
  const { state } = props.space;
  if (state.at === "freed") {
    return (
      <div role="status" className="flex items-start gap-3">
        <span className="flex size-6 shrink-0 items-center justify-center">
          <Check aria-hidden="true" className="size-5 text-green" />
        </span>
        <span className="flex min-w-0 flex-col gap-px">
          <span className="text-sm leading-6 font-medium">
            {state.freed === null
              ? "Freed up space"
              : `Freed ${formatBytes(state.freed)}`}
          </span>
          <span className="text-[13px] font-medium text-muted-foreground">
            {nothingLeft(state.plan)}
          </span>
        </span>
      </div>
    );
  }
  const problem = state.at === "failed";
  const line =
    state.at === "counting"
      ? "Counting what can go…"
      : state.at === "unknown"
        ? "Can't count them right now"
        : state.at === "freeing"
          ? "Freeing up space…"
          : problem
            ? state.reason
            : state.plan.bytes > 0
              ? `About ${formatBytes(state.plan.bytes)} to free: ${whatGoes(state.plan)}`
              : `Nothing to free up: ${nothingLeft(state.plan).toLowerCase()}`;
  return (
    <div
      role={state.at === "freeing" || problem ? "status" : undefined}
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5"
    >
      <span className="flex min-w-0 flex-1 items-start gap-3">
        {problem && (
          <span className="flex size-6 shrink-0 items-center justify-center">
            <CircleAlert
              aria-hidden="true"
              className="size-5 text-destructive"
            />
          </span>
        )}
        <span className="flex min-w-[12rem] flex-col gap-px">
          <span
            className={cn(
              "text-sm leading-6 font-medium",
              problem && "text-destructive",
            )}
          >
            {problem ? "Couldn't free up space" : "Old versions"}
          </span>
          <span className="text-[13px] font-medium text-muted-foreground">
            {line}
          </span>
        </span>
      </span>
      <FreeUpButton space={props.space} />
    </div>
  );
}
