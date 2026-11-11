import { Button } from "@meetsanctum/ui-sdk";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useRef, type ReactNode } from "react";

// An overlay: frosted Carbon glass over the whole screen, the top bar too,
// with a header along its top and its pages (SwipePages) filling the rest,
// each in the middle of the room above their tabs. The header holds what it
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
  "[data-slot=swipe-page-content], [data-slot=swipe-pages-tabs], [data-slot=scroll-area-scrollbar]";

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

export function Overlay(props: {
  container: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  /** Says it has come over the window, or has gone, its fade out ended. */
  onCovering: (covering: boolean) => void;
  title: string;
  /** The line under the title, in Silver. */
  subtitle?: ReactNode;
  /** What the header starts with, opposite Done. */
  leading?: ReactNode;
  children: ReactNode;
}) {
  const { onClose } = props;
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
          // Frosted Carbon glass is in Evening over a page in either mode.
          data-mode="evening"
          aria-describedby={undefined}
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
          // Over the top bar, whose strip on macOS would otherwise still
          // move the window under the overlay; its header moves it instead.
          className="overlay fixed inset-0 z-10 flex flex-col bg-(--carbon)/60 text-white outline-none backdrop-blur-[24px] [-webkit-app-region:no-drag] duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        >
          <WhileCovering onCovering={props.onCovering} />
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
                <Button variant="outline">Done</Button>
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
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
