import { Button } from "@meetsanctum/ui-sdk";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

import { VeilGlass } from "./veil";

// An overlay: the veil's frosted Carbon glass over the whole screen, the top bar too,
// with a header along its top and its pages (SwipePages) filling the rest,
// each in the middle of the room above their tabs, and a footer under them
// that stays put while they scroll. The header holds what it
// leads with, such as a device's Add to Home, the title, the line under it
// and Done, centred on the top bar's row, and in the desktop app on macOS
// moves the window between them (styles.css). The traffic lights hide until
// the overlay has gone (src/sidebar-state.ts), so nothing pushes what it
// leads with aside. A click or tap on the glass around a page's content, its
// tabs and its scrollbar closes it, as Done and Escape do; one that starts
// or ends on them does not, so a slider let go outside it leaves it open.
// Focus goes back to what opened it.

// A press on these keeps the overlay open; the pages around them span the
// glass.
const content =
  "[data-slot=swipe-page-content], [data-slot=swipe-pages-tabs], [data-slot=scroll-area-scrollbar], [data-slot=overlay-content], [data-slot=overlay-footer]";

// Inside the overlay's content, which stays until its fade out has ended, so
// this says when it is really gone rather than when it starts to go.
function WhileCovering(props: { onCovering: (covering: boolean) => void }) {
  const { onCovering } = props;
  useEffect(() => {
    onCovering(true);
    return () => onCovering(false);
  }, [onCovering]);
  return null;
}

// While a modal dialog is open Radix turns pointer events off on <body>,
// so nothing outside it takes a press. Every element inherits that, so the
// whole screen behind would be styled again as an overlay opened and again
// as it went. The container keeps pointer events itself while any overlay's
// content is there (data-holds-pointer, shell-frame.css), with a barrier
// under the veil to catch presses if a modal menu takes over. Set
// from inside the content, which Radix's own layer contains: it is set
// before Radix turns them off and cleared after it turns them back on.
const holding = new WeakMap<HTMLElement, number>();
function HoldsPointer(props: { container: HTMLElement | null }) {
  const { container } = props;
  useEffect(() => {
    if (!container) return;
    holding.set(container, (holding.get(container) ?? 0) + 1);
    container.dataset.holdsPointer = "";
    return () => {
      const left = (holding.get(container) ?? 1) - 1;
      holding.set(container, left);
      if (left === 0) delete container.dataset.holdsPointer;
    };
  }, [container]);
  return null;
}

// The overlays open over a container, which says it is covered while any
// is (data-covered, shell-frame.css), from as one opens until as it starts
// to go.
const openOver = new WeakMap<HTMLElement, number>();
function useCovers(container: HTMLElement | null, open: boolean) {
  useLayoutEffect(() => {
    if (!container || !open) return;
    openOver.set(container, (openOver.get(container) ?? 0) + 1);
    container.dataset.covered = "";
    return () => {
      const left = (openOver.get(container) ?? 1) - 1;
      openOver.set(container, left);
      if (left === 0) delete container.dataset.covered;
    };
  }, [container, open]);
}

export function Overlay(props: {
  container: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  /** Lets an inline editor handle Escape before the overlay closes. */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  /** Says it has come over the window, or has gone, its fade out ended. */
  onCovering: (covering: boolean) => void;
  title: string;
  /** The line under the title, in Silver. */
  subtitle?: ReactNode;
  /** Uses the primary button style when closing is the main action. */
  isDonePrimary?: boolean;
  /** What the header starts with, opposite Done. */
  leading?: ReactNode;
  /** Under the pages, along the bottom, however far they scroll. */
  footer?: ReactNode;
  /** A colour the veil's glass turns towards, such as what a player plays. */
  tint?: string | null;
  children: ReactNode;
}) {
  const { onClose } = props;
  useCovers(props.container, props.open);
  const opener = useRef<HTMLElement | null>(null);
  const glass = useRef<HTMLDivElement>(null);
  // Whether the press now under way started, and so far ended, on the
  // glass.
  const fromGlass = useRef(false);
  const onGlass = (target: EventTarget | null) =>
    target instanceof Element &&
    glass.current?.contains(target) === true &&
    target.closest(content) === null;

  return (
    <DialogPrimitive.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal container={props.container}>
        <DialogPrimitive.Content
          asChild
          aria-describedby={undefined}
          onEscapeKeyDown={props.onEscapeKeyDown}
          onOpenAutoFocus={() => {
            opener.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            opener.current?.focus();
          }}
        >
          {/* The veil's glass, in Evening over a page in either mode. Over
              the top bar, whose strip on macOS would otherwise still move
              the window under the overlay; its header moves it instead. */}
          <VeilGlass
            tint={props.tint}
            className="overlay z-10 flex flex-col outline-none [-webkit-app-region:no-drag] animation-duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          >
            <WhileCovering onCovering={props.onCovering} />
            <HoldsPointer container={props.container} />
            {/* Its sides keep their buttons' width, and the title takes what
              is left, ending in an ellipsis where it does not fit. It is
              centred on the top bar's row, which a phone's has higher. */}
            <header className="overlay-header grid shrink-0 grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-3 ps-[calc(24px+env(safe-area-inset-left))] pe-[calc(24px+env(safe-area-inset-right))] pt-[calc(13px+env(safe-area-inset-top))] pb-4 max-sm:pt-[calc(10px+env(safe-area-inset-top))]">
              <div className="flex justify-start">{props.leading}</div>
              <div className="flex min-w-0 flex-col items-center gap-0.5 text-center">
                <DialogPrimitive.Title className="m-0 max-w-full truncate text-xl leading-7 font-normal">
                  {props.title}
                </DialogPrimitive.Title>
                {props.subtitle && (
                  <p className="m-0 text-[13px] leading-[18px] font-medium text-(--silver)">
                    {props.subtitle}
                  </p>
                )}
              </div>
              <div className="flex justify-end">
                <DialogPrimitive.Close asChild>
                  <Button variant={props.isDonePrimary ? "default" : "outline"}>
                    Done
                  </Button>
                </DialogPrimitive.Close>
              </div>
            </header>
            <div
              ref={glass}
              data-slot="overlay-glass"
              // In the capture phase, since a slider keeps its presses to
              // itself.
              onPointerDownCapture={(event) => {
                fromGlass.current = onGlass(event.target);
              }}
              onPointerUpCapture={(event) => {
                // A touch stays with where it began, so what is under the
                // finger as it lifts says where it ended.
                const under =
                  document.elementFromPoint?.(event.clientX, event.clientY) ??
                  event.target;
                fromGlass.current &&= onGlass(under);
              }}
              onClick={(event) => {
                const close = fromGlass.current && onGlass(event.target);
                fromGlass.current = false;
                if (close) onClose();
              }}
              className="flex min-h-0 flex-1 flex-col"
            >
              {props.children}
              {props.footer && (
                <div
                  data-slot="overlay-footer"
                  className="shrink-0 ps-[calc(24px+env(safe-area-inset-left))] pe-[calc(24px+env(safe-area-inset-right))] pt-2 pb-[calc(24px+env(safe-area-inset-bottom))]"
                >
                  {props.footer}
                </div>
              )}
            </div>
          </VeilGlass>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
