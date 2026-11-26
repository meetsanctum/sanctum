import { cn } from "cn";
import type { LucideIcon } from "lucide-react";
import {
  startTransition,
  useEffect,
  useEffectEvent,
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
// room scrolls, on its own. Tabs too many for the width scroll sideways,
// fading out at the sides, and the current one is always in view.

// How far a press moves before it is a swipe, and how far a swipe goes to
// turn the page, in px.
const swipeAfter = 10;
const turnAfter = 60;
// How far the tabs fade out at the sides, and the room kept for it either
// side of them, in px.
const tabsFade = 24;

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
  "[&>[data-slot=scroll-area-viewport]]:[mask-image:linear-gradient(to_bottom,transparent,black_40px,black_calc(100%-40px),transparent)] reduce-effects:[&>[data-slot=scroll-area-viewport]]:[mask-image:none]",
);

type Swipe = {
  pointerId: number;
  x: number;
  y: number;
  active: boolean;
  /** How far the last move went sideways. */
  across: number;
};

export function SwipePages(props: {
  label: string;
  pages: SwipePage[];
  /** The page it opens on, by its id: the first unless said. */
  initial?: string;
  /** The page on show, including when it first opens. */
  onPageChange?: (id: string) => void;
}) {
  const { pages } = props;
  const [chosen, setChosen] = useState(() => {
    const index = Math.max(
      0,
      pages.findIndex((each) => each.id === props.initial),
    );
    return { id: pages[index]?.id, index };
  });
  // A capability or an app can add or remove pages while the detail is open.
  const selectedIndex = pages.findIndex((each) => each.id === chosen.id);
  const page =
    selectedIndex >= 0
      ? selectedIndex
      : Math.min(chosen.index, pages.length - 1);
  const swipe = useRef<Swipe | null>(null);
  // A swipe moves the pages straight away, by each page's own style, for
  // each move of the finger: drawing them again, or a value or selector
  // reaching every element on every page, would have a weak device look
  // at all of them again each time. While a finger moves them each page
  // is a layer of its own, so the device moves what it drew; when it lets
  // go they slide to their places.
  const cell = useRef<HTMLDivElement>(null);
  const sections = useRef<(HTMLElement | null)[]>([]);
  const follow = (dx: number | null) => {
    const element = cell.current;
    if (!element) return;
    if (dx === null) delete element.dataset.swiping;
    else element.dataset.swiping = "";
    for (const section of sections.current) {
      if (!section) continue;
      section.style.translate = dx === null ? "" : `${dx}px`;
      section.style.transition = dx === null ? "" : "none";
      section.style.willChange = dx === null ? "" : "transform";
    }
  };
  const swiped = useRef(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabRow = useRef<HTMLDivElement>(null);
  const id = useId();
  const pageId = pages[page]?.id;
  const announcePage = useEffectEvent((id: string) => props.onPageChange?.(id));
  // The page on show draws at once, and the others once it has painted,
  // so what opens draws only what is seen first: on a slow tablet a
  // device's history and activity cost as much as the rest together.
  const [drawsAll, setDrawsAll] = useState(false);
  const setPage = (index: number) => {
    if (index !== page) setDrawsAll(true);
    setChosen({ id: pages[index]?.id, index });
  };
  useEffect(() => {
    if (drawsAll) return;
    let later: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      later = setTimeout(() => setDrawsAll(true));
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(later);
    };
  }, [drawsAll]);

  // What the page change starts around the pages, such as a device's
  // detail taking the page's colour, waits while they slide, so a slow
  // device starts sliding them at once.
  useEffect(() => {
    if (pageId !== undefined) startTransition(() => announcePage(pageId));
  }, [pageId]);

  // The current tab scrolls into view, clear of the fade, however the page
  // was chosen: a swipe, a click or a key.
  useEffect(() => {
    const row = tabRow.current;
    const tab = tabs.current[page];
    if (!row || !tab) return;
    const start = tab.offsetLeft - tabsFade;
    const end = tab.offsetLeft + tab.offsetWidth + tabsFade;
    if (start < row.scrollLeft) row.scrollLeft = start;
    else if (end > row.scrollLeft + row.clientWidth) {
      row.scrollLeft = end - row.clientWidth;
    }
  }, [page]);

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
      across: 0,
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
      setDrawsAll(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    at.across = across;
    // Past the first or last page it follows a third as far.
    const edge =
      (page === 0 && across > 0) || (page === pages.length - 1 && across < 0);
    follow(edge ? across / 3 : across);
  };
  const finish = (across: number) => {
    swipe.current = null;
    follow(null);
    if (across < -turnAfter) setPage(Math.min(pages.length - 1, page + 1));
    else if (across > turnAfter) setPage(Math.max(0, page - 1));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const at = swipe.current;
    if (!at || at.pointerId !== event.pointerId) return;
    if (!at.active) {
      swipe.current = null;
      return;
    }
    finish(event.clientX - at.x);
  };
  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    const at = swipe.current;
    if (at?.pointerId !== event.pointerId) return;
    // A vertical move has already left the swipe to scrolling, so a cancel
    // once it is under way comes from around the page, such as a host app
    // that reports a lifted finger as cancelled: it ends where the last
    // move left it.
    finish(at.active ? at.across : 0);
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
        onLostPointerCapture={(event) => {
          // A finger's press holds an implicit capture on what it touched,
          // which ends with a lostpointercapture bubbling up here when the
          // swipe takes capture: only the pages' own loss ends the swipe.
          if (event.target === event.currentTarget) onPointerCancel(event);
        }}
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
            "[mask-image:linear-gradient(to_right,transparent,black_40px,black_calc(100%-40px),transparent)] reduce-effects:[mask-image:none]",
        )}
      >
        {/* The pages share one cell, the room above the tabs, each moved
            aside by its distance from the page on show, and a swipe moves
            them all by its own. */}
        <div
          ref={cell}
          className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]"
        >
          {pages.map((each, index) => (
            <section
              key={each.id}
              ref={(element) => {
                sections.current[index] = element;
              }}
              id={`${id}-${each.id}`}
              role={pages.length > 1 ? "tabpanel" : undefined}
              aria-label={pages.length > 1 ? undefined : each.label}
              aria-labelledby={
                pages.length > 1 ? `${id}-${each.id}-tab` : undefined
              }
              // Only the page on show can be reached.
              inert={index !== page}
              style={{
                transform: `translateX(${(index - page) * 100}%)`,
              }}
              className="col-start-1 row-start-1 min-h-0 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
            >
              {(drawsAll || index === page) && (
                <ScrollArea type="scroll" className={pageScroll}>
                  <div className="flex min-w-0 flex-1 flex-col items-center justify-center ps-[calc(24px+env(safe-area-inset-left))] pe-[calc(24px+env(safe-area-inset-right))] py-6 sm:ps-[calc(48px+env(safe-area-inset-left))] sm:pe-[calc(48px+env(safe-area-inset-right))]">
                    {/* Centred, with 16 px of its own around it, and no
                        wider than the room, so a page that can narrow does;
                        one that can't overflows both sides alike. */}
                    <div
                      data-slot="swipe-page-content"
                      data-muted={each.muted ? "" : undefined}
                      className="flex max-w-full flex-col items-center p-4 data-muted:opacity-50"
                    >
                      {each.content}
                    </div>
                  </div>
                </ScrollArea>
              )}
            </section>
          ))}
        </div>
      </div>
      {pages.length > 1 && (
        <div
          ref={tabRow}
          className="relative shrink-0 overflow-x-auto pt-2 pb-[calc(24px+env(safe-area-inset-bottom))] [mask-image:linear-gradient(to_right,transparent,black_24px,black_calc(100%-24px),transparent)] reduce-effects:[mask-image:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div
            role="tablist"
            data-slot="swipe-pages-tabs"
            aria-label={props.label}
            onKeyDown={onKeyDown}
            // Centred while they fit; from the start once they don't.
            className="mx-auto flex w-max gap-5 px-6"
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
