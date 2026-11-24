import {
  permissionWords,
  type AiAreaInfo,
  type AppInfo,
} from "@meetsanctum/app-sdk";
import { Button, type LiveFeed } from "@meetsanctum/ui-sdk";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AppIcon } from "../app-icon";
import { plainIcon } from "../app-settings";
import { Row, Section, SettingsPageBar } from "../components";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { permissionIconOf } from "../permission-icons";
import { switchArea, useAiCanUse } from "./data";
import { CanUseNote, CanUseRow, CanUseRows, switchProblem } from "./rows";
import {
  areaDetail,
  canUseTitle,
  offersOf,
  onCount,
  tellsWhosHome,
  toldWhatsOff,
  turnOnWords,
} from "./words";

// Settings → AI agents → What AI agents can use: the core's areas, one list
// for every AI agent, then each app that offers some of what it has, with
// how many of its items are on, opening its settings page, where they're
// switched. The areas that tell who's home have a card of their own, and
// each asks before it turns on; everything else switches at once, and
// turning anything off never asks.

export function CanUsePage(props: {
  apps: readonly AppInfo[];
  live: LiveFeed;
  onOpenApp: (id: string) => void;
  onDone: () => void;
  backTo?: string;
}) {
  const { canUse, acceptChange, hasFailed, refresh } = useAiCanUse(props.live);
  const [pending, setPending] = useState<{ id: string; on: boolean }>();
  const [asking, setAsking] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const focusAfterConfirm = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (asking || pending || !focusAfterConfirm.current) return;
    if (document.activeElement === document.body)
      focusAfterConfirm.current.focus();
    focusAfterConfirm.current = null;
  }, [asking, pending]);

  const change = async (id: string, on: boolean) => {
    setPending({ id, on });
    setProblem(undefined);
    try {
      acceptChange(await switchArea(id, on));
    } catch {
      setProblem(switchProblem);
      void refresh();
    } finally {
      setPending(undefined);
    }
  };

  const row = (area: AiAreaInfo) => {
    const words = permissionWords(area.id);
    return (
      <CanUseRow
        key={area.id}
        icon={permissionIconOf[words.icon]}
        title={words.title}
        detail={areaDetail[area.id]}
        always={area.always}
        on={pending?.id === area.id ? pending.on : area.on}
        disabled={pending !== undefined}
        onSwitch={(on, trigger) => {
          if (on && tellsWhosHome(area.id)) {
            focusAfterConfirm.current = trigger;
            setAsking(area.id);
          } else void change(area.id, on);
        }}
      />
    );
  };

  const areas = canUse?.areas ?? [];
  const offering = props.apps.filter(
    (app) => offersOf(canUse, app.id).length > 0,
  );
  const asked = asking ? { id: asking, ...turnOnWords(asking) } : undefined;
  return (
    <>
      <SettingsPageBar
        title={canUseTitle}
        backTo={props.backTo}
        onBack={props.onDone}
      />
      {hasFailed && !canUse && (
        <p role="alert" className="m-0 text-sm text-destructive">
          This didn't load. Go back and open it again.
        </p>
      )}
      {canUse && (
        <>
          <Section
            id="settings-ai-home"
            title="Your Home"
            hint="For every AI agent"
          >
            <CanUseRows>
              {areas.filter((area) => !tellsWhosHome(area.id)).map(row)}
            </CanUseRows>
          </Section>
          <Section
            id="settings-ai-whos-home"
            title="What Tells Who's Home"
            hint="Asks before each turns on"
          >
            <CanUseRows>
              {areas.filter((area) => tellsWhosHome(area.id)).map(row)}
            </CanUseRows>
            <CanUseNote problem={problem}>{toldWhatsOff}</CanUseNote>
          </Section>
          {offering.length > 0 && (
            <Section id="settings-ai-apps" title="In Your Apps">
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {offering.map((app) => (
                  <li key={app.id}>
                    <Button
                      variant="row"
                      size="row"
                      type="button"
                      onClick={() => props.onOpenApp(app.id)}
                      className="-mx-2.5 w-[calc(100%+20px)]"
                    >
                      <AppIcon
                        icon={app.icon ?? plainIcon}
                        className="size-9 [&_svg]:size-5"
                      />
                      <Row
                        title={app.name}
                        detail={onCount(offersOf(canUse, app.id))}
                      />
                      <ChevronRight
                        aria-hidden="true"
                        className="ms-auto size-4 shrink-0 text-muted-foreground"
                      />
                    </Button>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
      <Dialog
        open={asking !== undefined}
        onOpenChange={(open) => {
          if (!open) setAsking(undefined);
        }}
      >
        {asked && (
          <DialogContent
            showCloseButton={false}
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <DialogHeader>
              <DialogTitle>{asked.title}</DialogTitle>
              <DialogDescription>{asked.description}</DialogDescription>
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
                  void change(asked.id, true);
                }}
              >
                Turn on
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
