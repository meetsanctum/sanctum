import {
  permissionWords,
  type AppInfo,
  type PermissionInfo,
} from "@meetsanctum/app-sdk";
import { Button, Switch } from "@meetsanctum/ui-sdk";
import { useState } from "react";

import { productName } from "./brand";
import { Section } from "./components";
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

// An app's permissions on its settings page: each in Sanctum's words, with
// the app's reason under it, Needed for those it can't work without, and a
// switch. Every client may switch any. Turning off one the app needs asks
// first, since the app then pauses; the rest switch at once. The core
// answers with the app as it is now, which the shell takes for everything
// that shows it.

/** What went wrong switching a permission, in words, by the core's code. */
export function problemOf(
  error: unknown,
  app: AppInfo,
  title: string,
  granting = false,
) {
  const code = error instanceof CoreError ? error.code : null;
  if (code === "unavailable") {
    return granting
      ? `${productName} couldn't give ${app.name} “${title}” in time. Try again.`
      : `${app.name} still has “${title}”: ${productName} couldn't take it back in time. Try again.`;
  }
  if (code === "conflict") {
    return `Another change to ${app.name} is still under way. Try again in a moment.`;
  }
  return "That did not work. Try again.";
}

export function PermissionsSection(props: {
  app: AppInfo;
  onChanged: (app: AppInfo) => void;
}) {
  const { app } = props;
  // The switch being changed, shown where it is going until the core answers.
  const [pending, setPending] = useState<{ id: string; granted: boolean }>();
  const [asking, setAsking] = useState<PermissionInfo>();
  const [problem, setProblem] = useState<string>();

  const change = async (request: PermissionInfo, granted: boolean) => {
    setPending({ id: request.id, granted });
    setProblem(undefined);
    try {
      props.onChanged(
        await coreJson<AppInfo>(
          `/api/apps/${encodeURIComponent(app.id)}/permissions/update`,
          { method: "POST", json: { permission: request.id, granted } },
        ),
      );
    } catch (error) {
      setProblem(problemOf(error, app, permissionWords(request.id).title));
    } finally {
      setPending(undefined);
    }
  };

  return (
    <Section
      id="settings-app-permissions"
      title="Permissions"
      hint="Switch any off at any time"
    >
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {app.requests.map((request) => {
          const words = permissionWords(request.id);
          const Icon = permissionIconOf[words.icon];
          const granted =
            pending?.id === request.id
              ? pending.granted
              : app.permissions.includes(request.id);
          return (
            <li key={request.id} className="flex min-w-0 items-center gap-3">
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/8"
              >
                <Icon className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
                {/* The reason is the point of the row, so the row wraps
                    rather than cut it short, on a phone too. */}
                <span className="text-sm font-medium">{words.title}</span>
                <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
                  {words.detail && `${words.detail}. `}
                  {request.reason}
                  {/* While it's off, when the app asks for it. */}
                  {!granted && request.asked && ` Asked ${request.asked}.`}
                </span>
              </span>
              {request.needed && (
                <span className="shrink-0 text-[13px] font-medium text-muted-foreground">
                  Needed
                </span>
              )}
              <Switch
                aria-label={words.title}
                checked={granted}
                disabled={pending !== undefined}
                onCheckedChange={(next) => {
                  if (!next && request.needed) setAsking(request);
                  else void change(request, next);
                }}
              />
            </li>
          );
        })}
      </ul>
      {problem && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {problem}
        </p>
      )}
      <Dialog
        open={asking !== undefined}
        onOpenChange={(open) => {
          if (!open) setAsking(undefined);
        }}
      >
        {asking && (
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>
                Turn off “{permissionWords(asking.id).title}” for {app.name}?
              </DialogTitle>
              <DialogDescription>
                {app.name} needs it to work. It pauses until you turn this back
                on.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                autoFocus
                onClick={() => setAsking(undefined)}
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setAsking(undefined);
                  void change(asking, false);
                }}
              >
                Turn off
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </Section>
  );
}
