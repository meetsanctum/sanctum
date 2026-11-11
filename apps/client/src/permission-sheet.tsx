import { permissionWords, type AppInfo } from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { AppIcon } from "./app-icon";
import { problemOf } from "./app-permissions";
import { plainIcon } from "./app-settings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { coreJson } from "./core-fetch";
import { permissionIconOf } from "./permission-icons";

// The shell's sheet that asks for an app's optional permissions where its
// page is about to use them, and for a workflow piece as the editor adds it:
// each in Sanctum's words with the app's reason, so no app words the
// question itself. Allow turns them on through the grant route, and the
// shell takes the core's answer for everything that shows the app; Not now
// changes nothing and is not kept, so the next use asks again. One sheet at
// a time: a second ask waits.

type Asking = {
  id: number;
  app: string;
  permissions: readonly string[];
  resolve: (granted: boolean) => void;
};

// "see your remotes' presses and keep its own automations".
function asWords(titles: readonly string[]) {
  const words = titles.map(
    (title) => title.charAt(0).toLowerCase() + title.slice(1),
  );
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** Asking for apps' permissions: `ask` for the bridge, and the sheet to draw. */
export function usePermissionSheet(
  apps: readonly AppInfo[],
  onChanged: (app: AppInfo) => void,
) {
  const [queue, setQueue] = useState<readonly Asking[]>([]);
  const asked = useRef(0);
  const ask = useCallback(
    (app: string, permissions: readonly string[]) =>
      new Promise<boolean>((resolve) => {
        const id = ++asked.current;
        setQueue((current) => [...current, { id, app, permissions, resolve }]);
      }),
    [],
  );
  const [first] = queue;
  // Each ask is answered once, however often its sheet says it is done.
  const done = useCallback(
    (granted: boolean) => {
      if (!first) return;
      first.resolve(granted);
      setQueue((current) => current.filter((each) => each.id !== first.id));
    },
    [first],
  );
  const app = first && apps.find((each) => each.id === first.app);
  // An ask whose app has gone, as when it was removed meanwhile, can never
  // be shown: it is answered Not now, so the asks behind it can be.
  const gone = first !== undefined && app === undefined;
  useEffect(() => {
    if (gone) done(false);
  }, [gone, done]);
  const sheet = (
    <PermissionSheet
      // Each ask starts afresh, with no problem left from the last, and
      // stays itself while others queue behind it.
      key={first?.id ?? "none"}
      app={app}
      permissions={first?.permissions ?? []}
      onChanged={onChanged}
      onDone={done}
    />
  );
  return { ask, sheet };
}

function PermissionSheet(props: {
  app: AppInfo | undefined;
  permissions: readonly string[];
  onChanged: (app: AppInfo) => void;
  onDone: (granted: boolean) => void;
}) {
  const { app, onDone } = props;
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  // What is still off: one granted meanwhile, or by an Allow that failed
  // part way, isn't asked again.
  const off = app
    ? props.permissions.filter((id) => !app.permissions.includes(id))
    : [];
  const open = app !== undefined && props.permissions.length > 0;

  const allow = async () => {
    if (!app) return;
    setPending(true);
    setProblem(undefined);
    let current = app;
    try {
      for (const permission of off) {
        current = await coreJson<AppInfo>(
          `/api/apps/${encodeURIComponent(app.id)}/permissions/update`,
          { method: "POST", json: { permission, granted: true } },
        );
        props.onChanged(current);
      }
      onDone(true);
    } catch (error) {
      const failed = off.find((id) => !current.permissions.includes(id))!;
      setProblem(problemOf(error, app, permissionWords(failed).title, true));
    } finally {
      setPending(false);
    }
  };

  // All of them are on already, as when another device allowed them.
  const allOn = open && off.length === 0 && !pending;
  useEffect(() => {
    if (allOn) onDone(true);
  }, [allOn, onDone]);
  const words = off.map((id) => ({ id, ...permissionWords(id) }));
  const reasonOf = (id: string) =>
    app?.requests.find((request) => request.id === id)?.reason ?? "";
  return (
    <Dialog
      open={open && off.length > 0}
      onOpenChange={(next) => {
        if (!next && !pending) onDone(false);
      }}
    >
      {app && off.length > 0 && (
        <DialogContent showCloseButton={false}>
          <DialogHeader className="gap-3">
            <AppIcon
              icon={app.icon ?? plainIcon}
              className="size-12 [&_svg]:size-7"
            />
            {/* Several permissions make a long question, on two lines. */}
            <DialogTitle className="leading-[22px] text-balance">
              Allow {app.name} to {asWords(words.map((each) => each.title))}?
            </DialogTitle>
            {words.length === 1 ? (
              <DialogDescription>
                {words[0]!.detail && `${words[0]!.detail}. `}
                {reasonOf(words[0]!.id)}
              </DialogDescription>
            ) : (
              <DialogDescription asChild>
                <ul className="m-0 flex list-none flex-col gap-3 p-0">
                  {words.map((each) => {
                    const Icon = permissionIconOf[each.icon];
                    return (
                      <li key={each.id} className="flex items-start gap-3">
                        <span
                          aria-hidden="true"
                          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/8 text-foreground"
                        >
                          <Icon className="size-4" />
                        </span>
                        <span className="flex min-w-0 flex-col gap-px leading-tight">
                          <span className="text-sm font-medium text-foreground">
                            {each.title}
                          </span>
                          <span className="text-[13px] leading-[18px] font-medium">
                            {each.detail && `${each.detail}. `}
                            {reasonOf(each.id)}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </DialogDescription>
            )}
            <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
              You can switch {words.length === 1 ? "it" : "them"} off again in{" "}
              {app.name} settings.
            </p>
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
              onClick={() => onDone(false)}
            >
              Not now
            </Button>
            <Button disabled={pending} onClick={() => void allow()}>
              {problem ? "Try again" : "Allow"}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
