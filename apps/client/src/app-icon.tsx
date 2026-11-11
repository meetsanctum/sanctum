import type { AppIcon as AppIconInfo } from "@meetsanctum/app-sdk";
import { cn } from "cn";
import {
  AppWindow,
  BrushCleaning,
  CalendarDays,
  CloudSun,
  CookingPot,
  Inbox,
  ListChecks,
  MessageCircle,
  RadioTower,
  Settings,
  ShoppingBasket,
  Sparkles,
  Sun,
  SwatchBook,
  Utensils,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import { appArtwork } from "./app-artwork";

// Known glyph/colour pairs use the approved artwork. Other pairs keep a line
// glyph on their chosen colour. Keep this list explicit so the shell does
// not ship every Lucide icon.
const glyphs: Record<string, LucideIcon> = {
  "brush-cleaning": BrushCleaning,
  "calendar-days": CalendarDays,
  "cloud-sun": CloudSun,
  "cooking-pot": CookingPot,
  inbox: Inbox,
  "list-checks": ListChecks,
  "message-circle": MessageCircle,
  "radio-tower": RadioTower,
  settings: Settings,
  "shopping-basket": ShoppingBasket,
  sparkles: Sparkles,
  sun: Sun,
  "swatch-book": SwatchBook,
  utensils: Utensils,
  workflow: Workflow,
};

export function AppIcon(props: { icon: AppIconInfo; className?: string }) {
  const artwork = appArtwork.get(`${props.icon.glyph}:${props.icon.color}`);
  const Glyph = Object.hasOwn(glyphs, props.icon.glyph)
    ? glyphs[props.icon.glyph]!
    : AppWindow;
  return (
    <span
      className={cn(
        "grid size-18 shrink-0 place-items-center rounded-[22.5%] text-(--white)",
        props.className,
      )}
      style={artwork ? undefined : { background: `var(--${props.icon.color})` }}
    >
      {artwork ? (
        <img
          src={artwork}
          alt=""
          aria-hidden="true"
          draggable={false}
          width={256}
          height={256}
          className="block size-full object-contain"
        />
      ) : (
        <Glyph aria-hidden="true" className="size-1/2" strokeWidth={1.6} />
      )}
    </span>
  );
}
