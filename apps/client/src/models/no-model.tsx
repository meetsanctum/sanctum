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
import {
  availablePlaces,
  placeDetails,
  placeNames,
  placePrivacy,
  type Place,
} from "./words";

// Settings → AI Models before the home has a source: what's missing, then
// the places it can run as equal choices, each starting Add a source there,
// its icon in a tile of the page's colour.
// Whether what's asked stays in the home is said in words beside an icon,
// never by colour; none of the places is the one to pick, so none is blue.

const icons: Record<Place, { Icon: LucideIcon; Where: LucideIcon }> = {
  sanctum: { Icon: Server, Where: House },
  computer: { Icon: Laptop, Where: House },
  provider: { Icon: Cloud, Where: Globe },
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
    // The room around the head and the places grows with the card.
    <div className="@container">
      <Empty className="gap-8 pt-10 pb-6 @xl:gap-10 @xl:pt-14 @xl:pb-12">
        <EmptyHeader className="gap-3">
          <EmptyMedia variant="icon" className="mb-2">
            <Sparkles aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle id={titleId}>No AI model yet</EmptyTitle>
          <EmptyDescription>
            It's the brain of your home. Choose where it runs. You can add more
            later.
          </EmptyDescription>
        </EmptyHeader>
        <div className="@container w-full max-w-192">
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
              const { Icon, Where } = icons[place];
              return (
                <Button
                  key={place}
                  ref={index === 0 ? props.firstChoiceRef : undefined}
                  variant="tile"
                  size="card"
                  disabled={props.disabled}
                  onClick={(event) =>
                    props.onChoose(place, event.currentTarget)
                  }
                >
                  {/* Side by side, each place's words are centred under its
                      icon; stacked, a row reads better left-aligned. */}
                  <span className="flex h-full w-full items-center gap-3 @xl:flex-col @xl:gap-0 @xl:pt-1 @xl:text-center">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-background @xl:mb-2.5">
                      <Icon aria-hidden="true" className="size-5.5" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-pretty @xl:items-center @xl:gap-1">
                      <span className="text-sm leading-[19px] font-medium">
                        {placeNames[place]}
                      </span>
                      <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
                        {placeDetails[place]}
                      </span>
                      <span className="mt-0.5 text-xs leading-4 font-medium text-muted-foreground @xl:mt-auto @xl:pt-2.5">
                        {/* In the line, so it stays beside the first word however
                            the words wrap or centre. */}
                        <Where
                          aria-hidden="true"
                          className="mr-1.5 inline size-3.5 align-[-3px]"
                        />
                        {placePrivacy[place]}
                      </span>
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>
        </div>
      </Empty>
    </div>
  );
}
