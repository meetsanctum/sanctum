import { cn } from "cn";
import type { LucideIcon } from "lucide-react";
import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { ScrollArea } from "./components/ui/scroll-area";

// Pages side by side: a finger swipes between them, and so does a mouse;
// along the bottom a tab for each, an icon with a dot under the current one,
// which a click or the arrow keys change too. One page has no tabs. They
// fill their parent's height, an overlay's glass edge to edge, each page in
// the middle of the room above the tabs, and only a page taller than that
// room scrolls, on its own.

// How far a press moves before it is a swipe, and how far a swipe goes to
// turn the page, in px.
const swipeAfter = 10;
const turnAfter = 60;

export type SwipePage = {
  id: string;
  label: string;
  icon: LucideIcon;
  content: ReactNode;
  /** Shown faded, as an offline light's controls are. */
  muted?: boolean;
};

// Each page scrolls on its own, its thumb showing only while it scrolls.
// Radix sizes the box inside the viewport to its content; it fills the
// viewport at least, so a short page sits in the middle. What scrolls past
// the top or bottom fades out over 40 px, as the pages' sides do, which a
// page's own room hides at either end: 24 px around it and its content's
// 16.
const pageScroll = cn(
  "h-full",
  "[&>[data-slot=scroll-area-viewport]>div]:flex! [&>[data-slot=scroll-area-viewport]>div]:min-h-full",
  "[&>[data-slot=scroll-area-viewport]]:[mask-image:linear-gradient(to_bottom,transparent,black_40px,black_calc(100%-40px),transparent)]",
);

type Swipe = { pointerId: number; x: number; y: number; active: boolean };

export function SwipePages(props: {
  label: string;
  pages: SwipePage[];
  /** The page it opens on, by its id: the first unless said. */
  initial?: string;
}) {
  const { pages } = props;
  const [chosen, setPage] = useState(() =>
    Math.max(
      0,
      pages.findIndex((each) => each.id === props.initial),
    ),
  );
  const page = Math.min(chosen, pages.length - 1);
  const [dx, setDx] = useState<number | null>(null);
  const swipe = useRef<Swipe | null>(null);
  const swiped = useRef(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.isPrimary === false) return;
    swiped.current = false;
    // The scrollbar owns its drag and capture until release, even when
    // the pointer moves sideways off its track.
    if (
      event.target instanceof Element &&
      event.target.closest("[data-slot=scroll-area-scrollbar]")
    )
      return;
    if (pages.length < 2 || event.button !== 0) {
      return;
    }
    swipe.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      active: false,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const at = swipe.current;
    if (!at || at.pointerId !== event.pointerId) return;
    const across = event.clientX - at.x;
    const down = event.clientY - at.y;
    if (!at.active) {
      // A mostly vertical move scrolls the page instead.
      if (Math.abs(down) > swipeAfter && Math.abs(down) > Math.abs(across)) {
        swipe.current = null;
        swiped.current = true;
        return;
      }
      if (Math.abs(across) < swipeAfter) return;
      at.active = true;
      swiped.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    // Past the first or last page it follows a third as far.
    const edge =
      (page === 0 && across > 0) || (page === pages.length - 1 && across < 0);
    setDx(edge ? across / 3 : across);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const at = swipe.current;
    if (!at || at.pointerId !== event.pointerId) return;
    swipe.current = null;
    if (!at.active) return;
    const across = event.clientX - at.x;
    setDx(null);
    if (across < -turnAfter) setPage(Math.min(pages.length - 1, page + 1));
    else if (across > turnAfter) setPage(Math.max(0, page - 1));
  };
  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (swipe.current?.pointerId !== event.pointerId) return;
    swipe.current = null;
    setDx(null);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const next =
      event.key === "ArrowLeft"
        ? page - 1
        : event.key === "ArrowRight"
          ? page + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? pages.length - 1
              : null;
    if (next === null || next < 0 || next >= pages.length) return;
    event.preventDefault();
    setPage(next);
    tabs.current[next]?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={(event) => {
          // Before capture starts, the mouse can release outside the pages.
          if (
            swipe.current?.pointerId === event.pointerId &&
            !swipe.current.active
          ) {
            swipe.current = null;
          }
        }}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
        onClickCapture={(event) => {
          // A swipe that ends over a button does not press it.
          const moved = swiped.current;
          swiped.current = false;
          if (!moved || event.detail === 0) return;
          event.stopPropagation();
          event.preventDefault();
        }}
        // The pages span their parent and fade out over their last 40 px at
        // the sides as they move aside, so the one on show, its content well
        // inside, is never faded.
        className={cn(
          "min-h-0 flex-1 overflow-hidden [touch-action:pan-y]",
          pages.length > 1 &&
            "[mask-image:linear-gradient(to_right,transparent,black_40px,black_calc(100%-40px),transparent)]",
        )}
      >
        {/* The pages share one cell, the room above the tabs, each moved
            aside by its distance from the page on show. */}
        <div
          data-swiping={dx === null ? undefined : ""}
          className="group grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]"
        >
          {pages.map((each, index) => (
            <section
              key={each.id}
              id={`${id}-${each.id}`}
              role={pages.length > 1 ? "tabpanel" : undefined}
              aria-label={pages.length > 1 ? undefined : each.label}
              aria-labelledby={
                pages.length > 1 ? `${id}-${each.id}-tab` : undefined
              }
              // Only the page on show can be reached.
              inert={index !== page}
              style={{
                transform: `translateX(calc(${(index - page) * 100}% + ${dx ?? 0}px))`,
              }}
              className="col-start-1 row-start-1 min-h-0 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-data-swiping:transition-none motion-reduce:transition-none"
            >
              <ScrollArea type="scroll" className={pageScroll}>
                <div className="flex min-w-0 flex-1 flex-col items-center justify-center ps-[calc(24px+env(safe-area-inset-left))] pe-[calc(24px+env(safe-area-inset-right))] py-6 sm:ps-[calc(48px+env(safe-area-inset-left))] sm:pe-[calc(48px+env(safe-area-inset-right))]">
                  {/* Centred, with 16 px of its own around it, and no wider
                      than the room, so a page that can narrow does; one
                      that can't overflows both sides alike. */}
                  <div
                    data-slot="swipe-page-content"
                    data-muted={each.muted ? "" : undefined}
                    className="flex max-w-full flex-col items-center p-4 data-muted:opacity-50"
                  >
                    {each.content}
                  </div>
                </div>
              </ScrollArea>
            </section>
          ))}
        </div>
      </div>
      {pages.length > 1 && (
        <div className="flex shrink-0 justify-center pt-2 pb-[calc(24px+env(safe-area-inset-bottom))]">
          <div
            role="tablist"
            data-slot="swipe-pages-tabs"
            aria-label={props.label}
            onKeyDown={onKeyDown}
            className="flex gap-5"
          >
            {pages.map((each, index) => {
              const Icon = each.icon;
              const current = index === page;
              return (
                <button
                  key={each.id}
                  ref={(element) => {
                    tabs.current[index] = element;
                  }}
                  type="button"
                  role="tab"
                  id={`${id}-${each.id}-tab`}
                  aria-label={each.label}
                  aria-selected={current}
                  aria-controls={`${id}-${each.id}`}
                  tabIndex={current ? 0 : -1}
                  onClick={() => setPage(index)}
                  className="group relative grid size-11 place-items-center rounded-full text-white/45 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 aria-selected:text-white"
                >
                  <Icon aria-hidden="true" className="size-5" />
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-current opacity-0 transition-opacity group-aria-selected:opacity-100"
                  />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
