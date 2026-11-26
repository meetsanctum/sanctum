import { Button } from "@meetsanctum/ui-sdk";
import {
  Cloud,
  Globe,
  House,
  Laptop,
  Server,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useId, type Ref } from "react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { availablePlaces, placeNames, providerList, type Place } from "./words";

// Settings → AI Models before the home has a source: what's missing, then
// the places it can run as equal choices, each starting Add a source there.
// Whether what's asked stays in the home is said in words beside an icon,
// never by colour; none of the places is the one to pick, so none is blue.

const tiles: Record<
  Place,
  { Icon: LucideIcon; Where: LucideIcon; detail: string; privacy: string }
> = {
  sanctum: {
    Icon: Server,
    Where: House,
    detail: "With the Ollama app.",
    privacy: "Stays in your home",
  },
  computer: {
    Icon: Laptop,
    Where: House,
    detail: "A Mac or PC that runs Ollama.",
    // Sanctum lists only a computer's local models, never Ollama's cloud
    // ones, so what's asked stays on that computer.
    privacy: "Stays in your home",
  },
  provider: {
    Icon: Cloud,
    Where: Globe,
    detail: `${providerList}, with your own API key.`,
    privacy: "Leaves your home",
  },
};

export function NoModel(props: {
  // Whether Ollama can run on Sanctum itself; where it can't, that place
  // isn't offered.
  supportsSanctum: boolean;
  disabled?: boolean;
  firstChoiceRef: Ref<HTMLButtonElement>;
  onChoose: (place: Place, opener: HTMLButtonElement) => void;
}) {
  const titleId = useId();
  const shown = availablePlaces(props.supportsSanctum);
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Sparkles aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle id={titleId}>No AI model yet</EmptyTitle>
        <EmptyDescription>
          It's the brain of your home. Choose where it runs; you can add more
          than one.
        </EmptyDescription>
      </EmptyHeader>
      <div className="@container w-full max-w-184">
        <div
          role="group"
          aria-labelledby={titleId}
          className={
            shown.length === 3
              ? "grid gap-2.5 @xl:grid-cols-3"
              : "grid gap-2.5 @xl:grid-cols-2"
          }
        >
          {shown.map((place, index) => {
            const { Icon, Where, detail, privacy } = tiles[place];
            return (
              <Button
                key={place}
                ref={index === 0 ? props.firstChoiceRef : undefined}
                variant="tile"
                size="card"
                disabled={props.disabled}
                onClick={(event) => props.onChoose(place, event.currentTarget)}
              >
                <span className="flex h-full w-full items-center gap-3 @xl:flex-col @xl:items-start @xl:gap-1.5">
                  <Icon aria-hidden="true" className="size-5" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-pretty @xl:gap-1.5">
                    <span className="text-sm leading-[19px] font-medium">
                      {placeNames[place]}
                    </span>
                    <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
                      {detail}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs leading-4 font-medium text-muted-foreground @xl:mt-auto @xl:pt-1">
                      <Where aria-hidden="true" className="size-3.5" />
                      {privacy}
                    </span>
                  </span>
                </span>
              </Button>
            );
          })}
        </div>
      </div>
    </Empty>
  );
}
