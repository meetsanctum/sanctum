import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";

// Every button in Sanctum, the shell's and apps' pages' alike, is this one:
// shadcn's, with Sanctum's looks as its variants and its shapes as its
// sizes, so a page says what a button is rather than how it looks. What a
// button is pointing at, current, pressed or checked turns the ink wherever
// that applies.

// What turns a button the ink: the place on show; a switch that is on, or
// a button whose own words say it is on (data-on), such as On Home; and a
// choice that is chosen, where nothing else shows it. Written out whole, so
// Tailwind finds them.
const current =
  "aria-[current=page]:bg-foreground aria-[current=page]:text-background aria-[current=page]:hover:bg-foreground/90 aria-[current=page]:hover:text-background";
const pressed =
  "aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:hover:bg-foreground/90 aria-pressed:hover:text-background data-on:bg-foreground data-on:text-background data-on:hover:bg-foreground/90 data-on:hover:text-background";
const checked =
  "aria-checked:bg-foreground aria-checked:text-background aria-checked:hover:bg-foreground/90 aria-checked:hover:text-background";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Electric blue with White text: a page's one primary action.
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        // The mode's background in a hairline: the other actions, and Done.
        // On, as Add to Home is once a device is on Home, it turns the ink.
        outline: cn(
          "border-border bg-background text-foreground shadow-xs hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
          "aria-pressed:border-transparent data-on:border-transparent dark:aria-pressed:border-transparent dark:data-on:border-transparent",
          pressed,
        ),
        // No fill at rest, the ink at 8% under the pointer, as the sidebar's
        // places have it, and 12% while held down or while the menu it opens
        // is open: the top bar's buttons, rows' ⋮ menus, the sidebar.
        ghost: cn(
          "text-foreground hover:bg-foreground/8 hover:text-foreground active:bg-foreground/12 [&[aria-haspopup][aria-expanded=true]]:bg-foreground/12",
          current,
        ),
        // The ink at 8% at rest, 12% under the pointer: the sidebar's pinned
        // apps, a mood's icons, choices on a device's glass.
        tile: cn(
          "bg-foreground/8 text-foreground hover:bg-foreground/12 hover:text-foreground active:bg-foreground/16",
          current,
          pressed,
          checked,
        ),
        // The ink at 8% at rest, 12% under the pointer and while chosen: a
        // choice among others on a device's glass, which shows its own check.
        // The one a remote's press just picked (data-heard) is rung in the
        // ink.
        option:
          "bg-foreground/8 text-foreground hover:bg-foreground/12 hover:text-foreground active:bg-foreground/16 aria-checked:bg-foreground/12 data-heard:bg-foreground/16 data-heard:ring-[1.5px] data-heard:ring-foreground",
        // White at 14% over a dashboard's background, a tile's glass: White
        // with Carbon ink while on.
        glass:
          "bg-white/14 text-white hover:bg-white/20 hover:text-white active:bg-white/24 aria-pressed:bg-white aria-pressed:text-(--carbon) aria-pressed:hover:bg-white/90 aria-pressed:hover:text-(--carbon)",
        // A dashed outline where something can go but nothing is yet, such
        // as the sidebar's pins with nothing pinned.
        placeholder:
          "border-[1.5px] border-dashed border-foreground/28 text-foreground/65 hover:bg-foreground/5 hover:text-foreground",
        // A row in a card: the ink at 5% under the pointer, 8% while pressed.
        // A chosen row shows its own check.
        row: cn(
          "text-foreground hover:bg-foreground/5 hover:text-foreground active:bg-foreground/8",
          current,
        ),
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        // Text in the action colour, Light blue on Carbon.
        link: "text-(--action) underline-offset-4 hover:underline",
      },
      size: {
        // Words, with or without an icon, such as Done.
        default:
          "h-9 gap-1.5 px-4 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        sm: "h-8 gap-1 rounded-[min(var(--radius-md),10px)] px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5",
        // A wide action of its own, such as a card's button or a sheet's.
        lg: "h-11 gap-2 px-4 text-[15px]",
        // A small switch in a line of them, such as a room's Lights or a
        // mood's Preview.
        chip: "h-9 gap-1.5 px-3 text-[13px] has-data-[icon=inline-start]:ps-2.5",
        // A row's ⋮ menu and a dialog's close: 32 px with 10 px corners,
        // pressable in the 44 px around it.
        "icon-sm":
          "relative size-8 rounded-[min(var(--radius-md),10px)] after:absolute after:-inset-1.5 after:content-[''] in-data-[slot=button-group]:rounded-md",
        "icon-lg": "size-10",
        // The top bar's: 36 px with the sidebar's pins' 9 px corners and an
        // 18 px icon, pressable in the 44 px around it.
        bar: "relative size-9 rounded-sm before:absolute before:-inset-1 before:content-[''] [&_svg:not([class*='size-'])]:size-4.5",
        // A place in the sidebar: its icon, its name and its status.
        item: "h-10 justify-start gap-2.5 rounded-md ps-2 pe-3 text-left text-sm",
        // A tile in a grid, as tall as its grid says (--tile-height).
        tile: "h-(--tile-height,3rem) w-full rounded-sm p-0",
        // An app in Apps: its icon with its name under it.
        app: "h-auto w-26 flex-col gap-2 rounded-lg p-2 text-[13px] leading-[18px] font-normal",
        // A row in a card, in the card's type, which keeps its own words'
        // layout.
        row: "h-auto min-h-10 w-full justify-start gap-3 rounded-sm px-2.5 py-2 text-start text-[length:inherit] leading-[inherit] font-[inherit] whitespace-normal",
        // A choice on a device's glass: at least 48 px, in Body type.
        option:
          "h-auto min-h-12 w-full justify-start gap-2.5 rounded-md py-1.5 ps-4 pe-3.5 text-start text-[17px] leading-[22px] font-normal whitespace-normal",
        // Words in Label type, such as a section's link.
        label:
          "-mx-1 -my-0.5 h-auto gap-1 rounded-xs px-1 py-0.5 text-[13px] leading-[18px]",
        // Words within a line, in its type.
        inline:
          "-mx-1 -my-0.5 h-auto min-h-6 gap-0.5 rounded-xs px-1 py-0.5 text-[length:inherit] leading-[inherit]",
        // A person's avatar, round as avatars are.
        avatar: "size-10 rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
