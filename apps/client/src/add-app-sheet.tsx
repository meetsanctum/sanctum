import {
  permissionWords,
  serviceStorageWords,
  type AppInfo,
  type AppShortfall,
  type AvailableApp,
  type PermissionInfo,
} from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { HardDrive, MemoryStick, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { AppIcon, plainIcon } from "./app-icon";
import { permissionDetail } from "./app-permissions";
import { productName } from "./brand";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { CoreError, coreJson } from "./core-fetch";
import { permissionIconOf } from "./permission-icons";

// The sheet that adds an app the home could add, before any of its code
// runs: what it needs to work, each in Sanctum's words with the app's
// reason, then what it starts with that it could do without, and the memory
// and storage it takes, side by side above Cancel and Add, the same on every
// sheet. Every word is Sanctum's, drawn from the manifest,
// so no app can misstate what it asks for. What keeps it from being added
// says so in place of the lists, with what would help, and Add can't be
// pressed. Its other optional permissions are asked where they're first
// used, as for every app. Add grants what's listed and starts it, and the
// sheet closes onto the app, as Apps opens it.

const mebibyte = 1024 * 1024;

// "60 MB", "1.5 GB".
export function sizeWords(bytes: number) {
  const megabytes = bytes / mebibyte;
  if (megabytes >= 1024) {
    return `${Math.round((megabytes / 1024) * 10) / 10} GB`;
  }
  return `${Math.max(0, Math.floor(megabytes))} MB`;
}

/**
 * The memory it may use, in words: its own container's cap, or about what
 * it takes with the services it starts, whose allowances aren't all caps.
 */
export function memoryWords(app: AvailableApp) {
  const { servicesMemory } = app;
  if (servicesMemory === null) return "Not known now";
  if (servicesMemory === undefined) {
    return `Up to ${sizeWords(app.memory * mebibyte)}`;
  }
  return `About ${sizeWords((app.memory + servicesMemory) * mebibyte)}`;
}

/** What it keeps on Sanctum, its services' where they keep more. */
export function storageWords(app: AvailableApp) {
  const service = app.requests
    .filter((request) => request.needed || request.startsOn)
    .map((request) => serviceOf(request.id))
    .find(
      (name) => name !== undefined && Object.hasOwn(serviceStorageWords, name),
    );
  return service
    ? serviceStorageWords[service]!
    : `Up to ${sizeWords(app.data * mebibyte)}`;
}

const serviceOf = (permission: string) =>
  permission.startsWith("services:")
    ? permission.slice("services:".length)
    : undefined;

/** Its memory and storage, side by side, the same on every sheet. */
export function AppSize(props: { app: AvailableApp }) {
  return (
    <>
      <SizeBadge
        icon={MemoryStick}
        label="Memory"
        value={memoryWords(props.app)}
      />
      <SizeBadge
        icon={HardDrive}
        label="Storage"
        value={storageWords(props.app)}
      />
    </>
  );
}

function SizeBadge(props: { icon: LucideIcon; label: string; value: string }) {
  const Icon = props.icon;
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md bg-muted px-2.5 py-2">
      <Icon
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground"
      />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="text-[11px] leading-[14px] font-medium text-muted-foreground">
          {props.label}
        </span>
        <span className="text-[13px] leading-[18px] font-medium text-foreground">
          {props.value}
        </span>
      </span>
    </div>
  );
}

/** What keeps it from being added, and what would help, in words. */
export function shortfallWords(
  shortfall: AppShortfall,
  name: string,
): { title: string; line: string } {
  switch (shortfall.kind) {
    case "sanctum":
      return {
        title: `It needs a newer ${productName}.`,
        line: `Update ${productName} in Settings, then add it.`,
      };
    case "pages":
      return shortfall.needs === "sanctum"
        ? {
            title: `It needs a newer ${productName}.`,
            line: `Update ${productName} in Settings, then add it.`,
          }
        : {
            title: `Its pages were made for an older ${productName}.`,
            line: `A newer ${name} comes with an update of ${productName}.`,
          };
    case "memory":
      return {
        title: "There isn't room for it.",
        line: `It needs ${sizeWords(shortfall.needs)} of memory, and ${sizeWords(shortfall.free)} are left beside your other apps. Turning off an app you don't use makes room.`,
      };
    case "space":
      return {
        title: "There isn't space for it.",
        line: `Its data needs ${sizeWords(shortfall.needs)}, and ${sizeWords(shortfall.free)} are free beside what your other apps and updates need. Settings → System says what takes it.`,
      };
  }
}

/** Why adding an app did not work, from the core's answer. */
export function addProblemOf(error: unknown, app: AvailableApp) {
  const code = error instanceof CoreError ? error.code : null;
  switch (code) {
    case "conflict":
      return `${app.name} changed meanwhile, as when it was added on another device. Close this and look again.`;
    case "unavailable":
      return `${productName} can't add ${app.name} now. Close this and look again.`;
    case "app_failed":
      return `${app.name} is added, but ${productName} couldn't start it. It tries again when it restarts.`;
    default:
      return "That did not work. Try again.";
  }
}

/**
 * What an app asks for, each with Sanctum's words for it and its reason.
 * Install sheets can group permissions that share a summary and reason.
 */
export function Asks(props: {
  requests: readonly PermissionInfo[];
  compact?: boolean;
}) {
  const seen = new Set<string>();
  const rows = props.requests
    .map(({ id, reason }) => ({ id, reason, words: permissionWords(id) }))
    .filter(({ words, reason }) => {
      if (!props.compact) return true;
      const key = JSON.stringify([words.title, words.detail, reason]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {rows.map(({ id, words, reason }) => {
        const Icon = permissionIconOf[words.icon];
        const detail = props.compact ? words.detail : permissionDetail(words);
        return (
          <li key={id} className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/8 text-foreground"
            >
              <Icon className="size-4" />
            </span>
            <span className="flex min-w-0 flex-col gap-px leading-tight">
              <span className="text-sm font-medium text-foreground">
                {words.title}
              </span>
              <span className="text-[13px] leading-[18px] font-medium">
                {detail && `${detail}. `}
                {reason}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function AddAppSheet(props: {
  /** The app to add; none while the sheet is closed. */
  app: AvailableApp | undefined;
  /** What brought it up, above its title, as a stick plugged in. */
  lead?: string;
  offerId?: string;
  /** Someone pressed Add, whose answer the sheet then shows. */
  onAdding?: () => void;
  onAdded: (app: AppInfo) => void;
  onClose: () => void | Promise<void>;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { app } = props;
  const [pending, setPending] = useState<"add" | "close">();
  const [problem, setProblem] = useState<string>();
  const needed = app?.requests.filter((request) => request.needed) ?? [];
  const startsOn =
    app?.requests.filter((request) => !request.needed && request.startsOn) ??
    [];
  const [short] = app?.shortfalls ?? [];
  const blocked = short && app && shortfallWords(short, app.name);

  const add = async () => {
    if (!app) return;
    setPending("add");
    setProblem(undefined);
    props.onAdding?.();
    try {
      const added = await coreJson<AppInfo>("/api/apps/add", {
        method: "POST",
        json: { id: app.id, version: app.version, offerId: props.offerId },
      });
      props.onAdded(added);
    } catch (error) {
      setProblem(addProblemOf(error, app));
    } finally {
      setPending(undefined);
    }
  };

  const close = async () => {
    if (pending) return;
    setPending("close");
    setProblem(undefined);
    try {
      await props.onClose();
    } catch {
      setProblem("That did not work. Try again.");
    } finally {
      setPending(undefined);
    }
  };

  return (
    <Dialog
      open={app !== undefined}
      onOpenChange={(next) => {
        if (!next) void close();
      }}
    >
      {app && (
        // A long list scrolls within the screen, Add with it.
        <DialogContent
          showCloseButton={false}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
          onCloseAutoFocus={props.onCloseAutoFocus}
        >
          <DialogHeader className="gap-3">
            <AppIcon
              icon={app.icon ?? plainIcon}
              className="size-12 [&_svg]:size-7"
            />
            {props.lead && (
              <p className="m-0 text-sm font-medium text-muted-foreground">
                {props.lead}
              </p>
            )}
            <DialogTitle>Add {app.name}?</DialogTitle>
            {blocked ? (
              <DialogDescription className="rounded-md bg-muted px-3 py-2.5 text-foreground">
                <span className="font-medium">{blocked.title}</span>{" "}
                {blocked.line}
              </DialogDescription>
            ) : (
              <DialogDescription asChild>
                <div className="flex flex-col gap-3">
                  {needed.length > 0 && (
                    <>
                      <p className="m-0">It needs these to work:</p>
                      <Asks requests={needed} compact />
                    </>
                  )}
                  {startsOn.length > 0 && (
                    <>
                      <p className="m-0">
                        It starts with{" "}
                        {startsOn.length === 1 ? "this" : "these"} too, which
                        you can switch off in its settings:
                      </p>
                      <Asks requests={startsOn} compact />
                    </>
                  )}
                </div>
              </DialogDescription>
            )}
          </DialogHeader>
          {problem && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {problem}
            </p>
          )}
          {/* Its size, then Cancel and Add under it in the same two
              columns, so every sheet ends alike. */}
          <div className="grid grid-cols-2 gap-2">
            <AppSize app={app} />
            <Button
              variant="outline"
              className="mt-2"
              disabled={pending !== undefined}
              onClick={() => void close()}
            >
              Cancel
            </Button>
            <Button
              className="mt-2"
              disabled={pending !== undefined || blocked !== undefined}
              onClick={() => void add()}
            >
              {pending === "add" ? "Adding…" : "Add"}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
