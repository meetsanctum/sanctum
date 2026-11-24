import {
  aiAssistantPermission,
  type AiOfferInfo,
  type AppInfo,
} from "@meetsanctum/app-sdk";
import { Button, type LiveFeed } from "@meetsanctum/ui-sdk";
import { useState } from "react";

import { Section } from "../components";
import { switchOffer, useAgents, useAiCanUse } from "./data";
import { CanUseNote, CanUseRow, CanUseRows, switchProblem } from "./rows";
import {
  canUseTitle,
  missingWords,
  offersByGroup,
  offersOf,
  toldWhatsOff,
} from "./words";

// An app's part of what AI agents can use, on its settings page under its
// permissions: what AI agents can do in it, then what they can read from
// it, a switch each, every one switching at once. AI agents are optional,
// so it shows only once the home has one. An item that needs one of the
// core's areas while it's off says so, and where to change it.

export function AppCanUseSection(props: {
  app: AppInfo;
  apps: readonly AppInfo[];
  live: LiveFeed;
  // Opens What AI agents can use, where the core's areas are switched.
  onOpenCanUse?: () => void;
}) {
  const { agents } = useAgents(props.live);
  const { canUse, acceptChange, refresh } = useAiCanUse(props.live);
  const [pending, setPending] = useState<{ id: string; on: boolean }>();
  const [problem, setProblem] = useState<string>();
  const offers = offersOf(canUse, props.app.id);
  const hasAgent =
    (agents?.length ?? 0) > 0 ||
    props.apps.some((app) => app.permissions.includes(aiAssistantPermission));
  if (!canUse || !hasAgent || offers.length === 0) return null;

  const change = async (offer: AiOfferInfo, on: boolean) => {
    setPending({ id: offer.id, on });
    setProblem(undefined);
    try {
      acceptChange(await switchOffer(offer.app, offer.id, on));
    } catch {
      setProblem(switchProblem);
      void refresh();
    } finally {
      setPending(undefined);
    }
  };

  const { actions, information } = offersByGroup(offers);
  const group = (title: string, items: AiOfferInfo[]) =>
    items.length > 0 && (
      <div className="flex flex-col gap-2.5">
        <h3 className="m-0 text-[13px] font-semibold text-muted-foreground">
          {title}
        </h3>
        <CanUseRows>
          {items.map((offer) => {
            const missing = missingWords(offer, offers);
            return (
              <CanUseRow
                key={offer.id}
                title={offer.title}
                detail={
                  missing && (
                    <>
                      {missing.text}.{" "}
                      {missing.area && props.onOpenCanUse && (
                        <Button
                          variant="link"
                          size="inline"
                          onClick={props.onOpenCanUse}
                        >
                          Change it in Settings
                        </Button>
                      )}
                    </>
                  )
                }
                on={pending?.id === offer.id ? pending.on : offer.on}
                disabled={pending !== undefined}
                onSwitch={(on) => void change(offer, on)}
              />
            );
          })}
        </CanUseRows>
      </div>
    );

  return (
    <Section id="settings-app-ai" title={canUseTitle}>
      {group("Actions", actions)}
      {group("Information", information)}
      <CanUseNote problem={problem}>{toldWhatsOff}</CanUseNote>
    </Section>
  );
}
