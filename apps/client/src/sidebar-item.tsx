import { Button } from "@meetsanctum/ui-sdk";
import type { LucideIcon } from "lucide-react";
import type { CSSProperties } from "react";

// A place in the sidebar: its icon, Home's house, or for another dashboard a
// small swatch of its background, its name and its glanceable status. The
// current one is in the ink, White in Evening, like every active control;
// the sidebar is in Evening beside a place and in the device's mode beside
// an app's page.
export function SidebarItem(
  props: (
    | { icon: LucideIcon; colour?: string }
    | {
        /** A dashboard's background, as CSS. */
        swatch: string;
      }
  ) & {
    name: string;
    /** Its status, and the words a screen reader says for it. */
    meta?: { value: string; spoken: string };
    current: boolean;
    onSelect: () => void;
  },
) {
  return (
    <Button
      variant="ghost"
      size="item"
      aria-current={props.current ? "page" : undefined}
      onClick={props.onSelect}
      style={
        {
          "--item-colour":
            ("colour" in props && props.colour) ||
            "color-mix(in srgb, var(--ink) 85%, transparent)",
        } as CSSProperties
      }
      className="group"
    >
      {"swatch" in props ? (
        <span
          aria-hidden="true"
          style={{ background: props.swatch }}
          className="size-6 shrink-0 rounded-xs shadow-[inset_0_0_0_1px_rgb(255_255_255/16%)]"
        />
      ) : (
        <span className="grid size-6 shrink-0 place-items-center text-(--item-colour) group-aria-[current=page]:text-background">
          <props.icon aria-hidden="true" className="size-4.5" />
        </span>
      )}
      {/* A status as long as "Office and Hall" is cut before the name. */}
      <span
        className={
          props.meta ? "flex-1 whitespace-nowrap" : "min-w-0 flex-1 truncate"
        }
      >
        {props.name}
      </span>
      {props.meta && (
        <span className="min-w-0 truncate text-[13px] font-normal text-foreground/65 group-aria-[current=page]:text-background/65">
          <span aria-hidden={props.meta.spoken !== props.meta.value}>
            {props.meta.value}
          </span>
          {props.meta.spoken !== props.meta.value && (
            <span className="sr-only">{props.meta.spoken}</span>
          )}
        </span>
      )}
    </Button>
  );
}

/** A heading over a group of places in the sidebar, such as Rooms. */
export function SidebarHeading(props: { children: string }) {
  return (
    <h2 className="mx-2 mt-4 mb-1.5 text-[13px] leading-[18px] font-medium text-foreground/65 first:mt-0">
      {props.children}
    </h2>
  );
}
