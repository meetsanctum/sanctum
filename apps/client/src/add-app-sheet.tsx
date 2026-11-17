import {
  permissionWords,
  type AppInfo,
  type AppShortfall,
  type AvailableApp,
  type PermissionInfo,
} from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { useState } from "react";

import { AppIcon } from "./app-icon";
import { plainIcon } from "./app-settings";
import { productName } from "./brand";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { CoreError, coreJson } from "./core-fetch";
import { permissionIconOf } from "./permission-icons";

// The sheet that adds an app the home could add, before any of its code
// runs: what it needs to work, each in Sanctum's words with the app's
// reason, then what it starts with that it could do without, what it adds
// and the memory it takes. Every word is Sanctum's, drawn from the manifest,
// so no app can misstate what it asks for. What keeps it from being added
// says so in place of the lists, with what would help, and Add can't be
// pressed. Its other optional permissions are asked where they're first
// used, as for every app. Add grants what's listed and starts it, and the
// sheet closes onto its settings.

const mebibyte = 1024 * 1024;

// "60 MB", "1.5 GB".
export function sizeWords(bytes: number) {
  const megabytes = bytes / mebibyte;
  if (megabytes >= 1024) {
    return `${Math.round((megabytes / 1024) * 10) / 10} GB`;
  }
  return `${Math.max(0, Math.floor(megabytes))} MB`;
}

const counted = ["no", "a", "two", "three", "four", "five", "six"];

// "a widget", "two workflow pieces".
function many(count: number, one: string, more = `${one}s`) {
  const number = counted[count] ?? String(count);
  return `${number} ${count === 1 ? one : more}`;
}

function list(words: readonly string[]) {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** What it adds to the home and the memory it takes, in one or two sentences. */
export function addsWords(app: AvailableApp) {
  const { adds } = app;
  const parts = [
    ...(adds.devices ? ["devices"] : []),
    ...(adds.widgets > 0 ? [many(adds.widgets, "widget")] : []),
    ...(adds.roomSections > 0 ? [many(adds.roomSections, "room section")] : []),
    ...(adds.devicePages > 0
      ? [
          many(
            adds.devicePages,
            "page in a device's detail",
            "pages in devices' detail",
          ),
        ]
      : []),
    ...(adds.pieces > 0 ? [many(adds.pieces, "workflow piece")] : []),
  ];
  const runs = `It runs on its own with up to ${app.memory} MB of memory.`;
  return parts.length > 0 ? `It adds ${list(parts)}. ${runs}` : runs;
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
        line: `Its data needs ${sizeWords(shortfall.needs)}, and ${sizeWords(shortfall.free)} are free beside what your other apps and updates need. Settings → Status says what takes it.`,
      };
  }
}

function problemOf(error: unknown, app: AvailableApp) {
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

function Asks(props: { requests: readonly PermissionInfo[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {props.requests.map((request) => {
        const words = permissionWords(request.id);
        const Icon = permissionIconOf[words.icon];
        return (
          <li key={request.id} className="flex items-start gap-3">
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
                {words.detail && `${words.detail}. `}
                {request.reason}
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
  onAdded: (app: AppInfo) => void;
  onClose: () => void;
}) {
  const { app } = props;
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const needed = app?.requests.filter((request) => request.needed) ?? [];
  const startsOn =
    app?.requests.filter((request) => !request.needed && request.startsOn) ??
    [];
  const [short] = app?.shortfalls ?? [];
  const blocked = short && app && shortfallWords(short, app.name);

  const add = async () => {
    if (!app) return;
    setPending(true);
    setProblem(undefined);
    try {
      const added = await coreJson<AppInfo>("/api/apps/add", {
        method: "POST",
        json: { id: app.id, version: app.version },
      });
      props.onAdded(added);
    } catch (error) {
      setProblem(problemOf(error, app));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={app !== undefined}
      onOpenChange={(next) => {
        if (!next && !pending) props.onClose();
      }}
    >
      {app && (
        <DialogContent showCloseButton={false}>
          <DialogHeader className="gap-3">
            <AppIcon
              icon={app.icon ?? plainIcon}
              className="size-12 [&_svg]:size-7"
            />
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
                      <Asks requests={needed} />
                    </>
                  )}
                  {startsOn.length > 0 && (
                    <>
                      <p className="m-0">
                        It starts with{" "}
                        {startsOn.length === 1 ? "this" : "these"} too, which
                        you can switch off in its settings:
                      </p>
                      <Asks requests={startsOn} />
                    </>
                  )}
                  <p className="m-0">{addsWords(app)}</p>
                </div>
              </DialogDescription>
            )}
          </DialogHeader>
          {problem && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={props.onClose}
            >
              Cancel
            </Button>
            <Button
              disabled={pending || blocked !== undefined}
              onClick={() => void add()}
            >
              {pending ? "Adding…" : `Add ${app.name}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
