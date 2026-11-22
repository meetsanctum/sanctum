import type { AiOfferInfo, AppInfo } from "@meetsanctum/app-sdk";
import type { AgentInfo } from "@meetsanctum/auth-protocol";
import { Button } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

import { Section } from "../components";
import { coreJson } from "../core-fetch";
import { switchOffer, useAiCanUse } from "./data";
import { CanUseNote, CanUseRow, CanUseRows, switchProblem } from "./rows";
import { missingWords, offersOf, toldWhatsOff } from "./words";

// An app's part of what AI agents can use, on its settings page under its
// permissions: what AI agents can do in it, then what they can read from
// it, a switch each, every one switching at once. AI agents are optional,
// so it shows only once the home has one. An item that needs one of the
// core's areas while it's off says so, and where to change it.

/** Whether the home has an AI agent, once the core has said. */
function useHasAgents() {
  const [has, setHas] = useState<boolean>();
  useEffect(() => {
    let stopped = false;
    coreJson<AgentInfo[]>("/api/auth/agents").then(
      (agents) => {
        if (!stopped) setHas(agents.length > 0);
      },
      () => undefined,
    );
    return () => {
      stopped = true;
    };
  }, []);
  return has;
}

export function AppCanUseSection(props: {
  app: AppInfo;
  // Opens What AI agents can use, where the core's areas are switched.
  onOpenCanUse?: () => void;
}) {
  const hasAgents = useHasAgents();
  const { canUse, setCanUse } = useAiCanUse();
  const [pending, setPending] = useState<{ id: string; on: boolean }>();
  const [problem, setProblem] = useState<string>();
  const offers = offersOf(canUse, props.app.id);
  if (!hasAgents || offers.length === 0) return null;

  const change = async (offer: AiOfferInfo, on: boolean) => {
    setPending({ id: offer.id, on });
    setProblem(undefined);
    try {
      setCanUse(await switchOffer(offer.app, offer.id, on));
    } catch {
      setProblem(switchProblem);
    } finally {
      setPending(undefined);
    }
  };

  // Actions that change something are what AI agents can do; reads and
  // entity types are what they can know.
  const actions = offers.filter(
    (offer) => offer.kind === "action" && offer.tier === "write",
  );
  const information = offers.filter((offer) => !actions.includes(offer));
  const group = (title: string, items: AiOfferInfo[]) =>
    items.length > 0 && (
      <div className="flex flex-col gap-2.5">
        <h3 className="m-0 text-[13px] font-semibold text-muted-foreground">
          {title}
        </h3>
        <CanUseRows>
          {items.map((offer) => {
            const missing = missingWords(offer, canUse!.offers);
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
    <Section id="settings-app-ai" title="What AI agents can use">
      {group("Actions", actions)}
      {group("Information", information)}
      <CanUseNote problem={problem}>{toldWhatsOff}</CanUseNote>
    </Section>
  );
}
