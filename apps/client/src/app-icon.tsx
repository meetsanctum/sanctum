import type { AppIcon as AppIconInfo } from "@meetsanctum/app-sdk";
import { cn } from "cn";
import {
  AppWindow,
  BrushCleaning,
  CalendarDays,
  CloudSun,
  CookingPot,
  Cpu,
  Inbox,
  ListChecks,
  MessageCircle,
  RadioTower,
  Settings,
  ShoppingBasket,
  Sparkles,
  Sun,
  SwatchBook,
  Tv,
  Utensils,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import { appArtwork } from "./app-artwork";

// Keep the fallback glyphs explicit so the shell ships only the Lucide
// icons it uses.
const glyphs: Record<string, LucideIcon> = {
  "brush-cleaning": BrushCleaning,
  "calendar-days": CalendarDays,
  "cloud-sun": CloudSun,
  "cooking-pot": CookingPot,
  cpu: Cpu,
  inbox: Inbox,
  "list-checks": ListChecks,
  "message-circle": MessageCircle,
  "radio-tower": RadioTower,
  settings: Settings,
  "shopping-basket": ShoppingBasket,
  sparkles: Sparkles,
  sun: Sun,
  "swatch-book": SwatchBook,
  tv: Tv,
  utensils: Utensils,
  workflow: Workflow,
};

export const plainIcon = { glyph: "app-window", color: "graphite" } as const;

export function AppIcon(props: {
  appId?: string;
  icon: AppIconInfo;
  className?: string;
}) {
  const key = `${props.icon.glyph}:${props.icon.color}`;
  const artwork =
    (props.appId ? appArtwork.get(`${props.appId}:${key}`) : undefined) ??
    appArtwork.get(key);
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
