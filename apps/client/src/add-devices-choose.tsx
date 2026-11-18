import type { DeviceOffer } from "@meetsanctum/app-sdk";
import { Button, buttonVariants } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { Radio, Wifi } from "lucide-react";
import type { ReactNode } from "react";

import { offerFoundWords } from "./add-devices-offer";

// Add devices' first page: what are you adding? A card for each way the home
// can add devices, side by side: the devices drivers found, with how many,
// and each radio that lets new devices join, by its app's name. The whole
// card is what you press; its Start says so. An app the home could add for
// devices found on its network says how many, and pressing it opens its add
// sheet. A radio the home never set up stays in place, dimmed, saying what
// to plug in. On a phone the cards stack.

/** A way to add devices, as the first page offers it. */
export type Way =
  | { kind: "found"; count: number }
  // A radio, by its app's id.
  | { kind: "join"; driver: string; name: string }
  // An app the home could add for devices found on its network.
  | { kind: "offer"; offer: DeviceOffer }
  // A radio whose app waits for what the home never set up.
  | { kind: "notSetUp"; name: string; fix: string };

export function ChoosePage(props: {
  ways: readonly Way[];
  onChoose: (way: Way, button: HTMLButtonElement) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-9 pt-[max(2rem,8vh)]">
      <h3 className="m-0 text-center text-[28px] leading-9 font-semibold tracking-[-0.015em] max-sm:text-2xl">
        What are you adding?
      </h3>
      {props.ways.length === 0 ? (
        <p role="alert" className="m-0 text-center text-(--silver)">
          No app that adds devices is running.
        </p>
      ) : (
        <ul className="m-0 flex w-full list-none flex-col gap-3.5 p-0 sm:flex-row sm:flex-wrap sm:justify-center sm:gap-5">
          {props.ways.map((way, index) => (
            <li
              key={
                way.kind === "join"
                  ? `join-${way.driver}`
                  : way.kind === "offer"
                    ? `offer-${way.offer.app}`
                    : way.kind
              }
              style={{ animationDelay: `${80 + index * 80}ms` }}
              className="flex motion-safe:animate-in motion-safe:fill-mode-both motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-4 motion-safe:duration-500 motion-reduce:animate-in motion-reduce:fill-mode-both motion-reduce:fade-in-0 sm:w-66"
            >
              <WayCard way={way} onChoose={props.onChoose} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WayCard(props: {
  way: Way;
  onChoose: (way: Way, button: HTMLButtonElement) => void;
}) {
  const { way } = props;
  const isOff = way.kind === "notSetUp";
  const badge =
    way.kind === "found"
      ? way.count > 0
        ? `${way.count} found`
        : "None found"
      : isOff
        ? "Not set up"
        : null;
  return (
    <Button
      variant="choice"
      size="choice"
      disabled={isOff}
      onClick={(event) => props.onChoose(way, event.currentTarget)}
      className={cn("group/way", isOff && "bg-white/5 from-white/5 to-white/5")}
    >
      <Round dim={isOff}>
        {way.kind === "found" || way.kind === "offer" ? (
          <Wifi className="size-8.5" strokeWidth={1.75} />
        ) : (
          <Radio className="size-8.5" strokeWidth={1.75} />
        )}
      </Round>
      <span
        className={cn(
          "mt-5.5 text-[19px] leading-6 font-semibold tracking-[-0.01em]",
          isOff && "opacity-60",
        )}
      >
        {way.kind === "found"
          ? "Devices found"
          : way.kind === "offer"
            ? way.offer.name
            : way.name}
      </span>
      <span className="mt-1.5 max-w-48 text-sm leading-5 text-(--silver)">
        {way.kind === "found"
          ? "Already on your Wi‑Fi"
          : way.kind === "join"
            ? "Lights, sensors and remotes"
            : way.kind === "offer"
              ? offerFoundWords(way.offer)
              : way.fix}
      </span>
      <span className="mt-auto flex w-full flex-col items-center gap-3.5 pt-4">
        <span className="flex h-6 items-center">
          {badge && (
            <span
              className={cn(
                "inline-flex h-6 items-center rounded-full px-2.75 text-[13px] font-semibold tabular-nums",
                way.kind === "found" && way.count > 0
                  ? "bg-white/16"
                  : "bg-white/8 text-(--silver)",
              )}
            >
              {badge}
            </span>
          )}
        </span>
        {/* The card is the button; this says what pressing it does. */}
        <span
          aria-hidden="true"
          className={cn(
            buttonVariants({ variant: "default", size: "lg" }),
            "w-full font-semibold group-hover/way:bg-primary/80",
            isOff && "opacity-40",
          )}
        >
          {way.kind === "offer" ? `Add ${way.offer.name}` : "Start"}
        </span>
      </span>
    </Button>
  );
}

function Round(props: { dim: boolean; children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-19 shrink-0 items-center justify-center rounded-full bg-white/14 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)]",
        props.dim && "opacity-45",
      )}
    >
      {props.children}
    </span>
  );
}
