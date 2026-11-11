import type { AppInfo, PieceInfo, WorkflowNode } from "@meetsanctum/app-sdk";
import { cn } from "cn";
import {
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleMinus,
  CircleX,
  Clock,
  Footprints,
  Hand,
  Lightbulb,
  Power,
  Sun,
  Sunrise,
  Sunset,
  Thermometer,
  ToggleRight,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { AppIcon } from "../app-icon";
import { presetOf, type Names, type Part } from "./words";
import type { StatusKind } from "./when";

// What Automations' pages share: a piece's icon, a trigger's card, a status
// with its icon, and a sentence's text and tokens.

// The glyphs the core names for its pieces (PieceInfo.icon); the shell
// ships only these.
const glyphs: Record<string, LucideIcon> = {
  clock: Clock,
  sunrise: Sunrise,
  sunset: Sunset,
  hand: Hand,
  lightbulb: Lightbulb,
  "circle-dot": CircleDot,
  "toggle-right": ToggleRight,
  footprints: Footprints,
  sun: Sun,
};
// A device's piece without a glyph of its own shows the device's kind.
const kindGlyphs: Record<string, LucideIcon> = {
  light: Lightbulb,
  switch: ToggleRight,
  button: CircleDot,
  occupancy: Footprints,
  sensor: Thermometer,
};

/** A piece's icon: its app's, its own glyph, or its device's kind. */
export function PieceIcon(props: {
  piece: PieceInfo | undefined;
  node?: Pick<WorkflowNode, "config">;
  apps: readonly AppInfo[];
  names: Names;
  size?: "default" | "small";
}) {
  const small = props.size === "small";
  const app = props.piece?.app
    ? props.apps.find((each) => each.id === props.piece!.app)
    : undefined;
  if (app?.icon) {
    return (
      <AppIcon
        icon={app.icon}
        className={cn(
          "shrink-0 rounded-[22.5%]",
          small ? "size-4 [&_svg]:size-[11px]" : "size-7 [&_svg]:size-4",
        )}
      />
    );
  }
  const config = props.node?.config ?? {};
  const preset = props.piece && presetOf(props.piece, config);
  const device =
    typeof config.device === "string"
      ? props.names.device(config.device)
      : undefined;
  const Glyph =
    glyphs[preset?.icon ?? props.piece?.icon ?? ""] ??
    kindGlyphs[(config.kind as string) ?? device?.kinds[0] ?? ""] ??
    Workflow;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center bg-foreground/8 text-foreground",
        small ? "size-4 rounded-[4px]" : "size-7 rounded-[6px]",
      )}
    >
      <Glyph
        className={small ? "size-[11px]" : "size-4"}
        strokeWidth={small ? 2.25 : 1.75}
      />
    </span>
  );
}

const statusGlyphs: Record<StatusKind, LucideIcon> = {
  ran: CircleCheck,
  skipped: CircleMinus,
  failed: CircleX,
  next: Clock,
  off: Power,
  problem: CircleAlert,
};

/** A state in words with its icon, the same in the list and the history. */
export function Status(props: {
  kind: StatusKind | null;
  ink?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const Glyph = props.kind ? statusGlyphs[props.kind] : undefined;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 text-[13px] leading-[18px] font-medium",
        props.ink ? "text-foreground" : "text-muted-foreground",
        props.className,
      )}
    >
      {Glyph && <Glyph aria-hidden="true" className="size-3.5 shrink-0" />}
      {props.children}
    </span>
  );
}

/**
 * A trigger's card, leading a row in the list: its icon, its name and its
 * specifics, the same shape for every type of trigger. A fill like a
 * token's, not a card in a card. On a phone it is one line, above the
 * row's name.
 */
export function TriggerCard(props: {
  icon: ReactNode;
  name: string;
  specifics: string | null;
  more?: number;
}) {
  return (
    <span className="flex w-41 min-w-0 shrink-0 items-center gap-2 rounded-sm bg-foreground/12 py-1.5 ps-1.5 pe-2 text-start max-sm:w-auto max-sm:max-w-full max-sm:py-0.5 max-sm:ps-0.5 max-sm:pe-2.5">
      {props.icon}
      <span className="flex min-w-0 flex-col text-[13px] leading-[18px] max-sm:flex-row max-sm:gap-1.5">
        <span className="truncate font-medium">{props.name}</span>
        {props.specifics && (
          <span className="truncate text-muted-foreground">
            {props.specifics}
          </span>
        )}
      </span>
      {props.more ? (
        <span className="ms-auto ps-1 text-[13px] leading-[18px] font-medium text-muted-foreground">
          +{props.more}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A sentence's text and values. Read only, values are in Medium; in the
 * editor each is a token, pressed to change it, through `token`.
 */
export function Sentence(props: {
  parts: Part[];
  token?: (part: Exclude<Part, string>, index: number) => ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("text-[15px] leading-8", props.className)}>
      {props.parts.map((part, index) =>
        typeof part === "string" ? (
          <span key={index}>{part}</span>
        ) : props.token ? (
          <span key={index}>{props.token(part, index)}</span>
        ) : part.missing ? (
          <span
            key={index}
            className="rounded-sm border border-dashed border-muted-foreground px-1.5 py-px font-medium"
          >
            {part.text}
          </span>
        ) : (
          <span key={index} className="font-medium">
            {part.text}
          </span>
        ),
      )}
    </span>
  );
}

/** A small round avatar in a person's colour, beside their name. */
export function MiniAvatar(props: { name: string; colour: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-grid size-4.5 shrink-0 place-items-center rounded-full text-[10px] leading-none font-medium text-(--carbon)"
      style={{ background: props.colour }}
    >
      {props.name.charAt(0).toUpperCase()}
    </span>
  );
}
