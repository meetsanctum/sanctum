import { Dialog as DialogPrimitive } from "radix-ui";
import { useRef, type ReactNode, type RefObject } from "react";

import { DialogOverlay, DialogPortal } from "./components/ui/dialog";
import type { SidebarLayout } from "./sidebar-state";

// The signed-in screen's frame: the window is a frame the sidebar sits on,
// and the page is a panel inset from it with rounded corners, the top bar
// inside. The frame takes the page's colour: beside a place, its dashboard's
// background deepened, with the sidebar in Evening in either mode; beside an
// app's page, the device's mode, Carbon or White's card fill. The two
// cross-fade, opacity only. On macOS the window's sidebar material shows
// through it, except under the glass of what covers the window, which would
// let the sidebar through sharp (shell-frame.css). Collapsed, the sidebar
// and the traffic lights go, and the page takes the window's width in the
// same frame; the window's left edge brings the sidebar in over the page,
// floating as frosted glass, until the pointer leaves it. Where the window
// is too narrow to dock, the toggle brings it in like that, over a dimmed
// page, until a place is chosen, Escape or a tap beside it.
export function ShellFrame(props: {
  screenRef: (element: HTMLDivElement | null) => void;
  layout: SidebarLayout;
  /** A place is on show, whose dashboard colours the frame. */
  isPlace: boolean;
  /** The dashboard's background, deepened for the frame and as the floating sidebar's glass. */
  place: { frame: string; glass: string } | undefined;
  deviceMode: "day" | "evening";
  panelBackground: string | undefined;
  isVeiled: boolean;
  /** The sidebar's content, docked or floating. */
  sidebar: (isFloating: boolean) => ReactNode;
  /** Where focus goes when the floating sidebar closes: the top bar's toggle. */
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** The top bar and the page. */
  panel: ReactNode;
  /** What covers the window: the veil and a device's detail. */
  children?: ReactNode;
}) {
  const { layout } = props;
  // The floating sidebar's content, where the toggle's focus starts.
  const floating = useRef<HTMLDivElement>(null);
  const sidebarMode = props.isPlace ? "evening" : props.deviceMode;
  const isFloating = layout.floating !== null;
  return (
    <div
      ref={props.screenRef}
      className="home-screen"
      data-sidebar={layout.docked ? "docked" : undefined}
      data-sliding={layout.isSliding ? "" : undefined}
    >
      <div
        aria-hidden="true"
        className="frame frame-neutral"
        data-mode={props.deviceMode}
        data-on={props.isPlace ? undefined : ""}
      />
      <div
        aria-hidden="true"
        className="frame frame-place"
        style={{ background: props.place?.frame }}
        data-on={props.isPlace ? "" : undefined}
      />
      <div
        aria-hidden="true"
        className="frame frame-under-glass"
        data-mode={props.deviceMode}
        style={props.isPlace ? { background: props.place?.frame } : undefined}
      />
      <div aria-hidden="true" className="frame-top" />
      <aside
        aria-label="Sidebar"
        className="sidebar-column"
        data-mode={sidebarMode}
        data-shown={layout.docked ? "" : undefined}
        data-instant={layout.isHandingOver ? "" : undefined}
        inert={!layout.docked || props.isVeiled}
      >
        {props.sidebar(false)}
      </aside>
      <div className="panel" style={{ background: props.panelBackground }}>
        {props.panel}
      </div>
      {layout.edge && (
        <div aria-hidden="true" className="sidebar-edge" {...layout.edge} />
      )}
      <DialogPrimitive.Root
        open={isFloating}
        // In from the edge it neither traps focus nor dims the page.
        modal={layout.floating !== "peek"}
        onOpenChange={(open) => {
          if (!open) layout.close();
        }}
      >
        <DialogPortal>
          <DialogOverlay className="bg-black/20 duration-300 supports-backdrop-filter:backdrop-blur-none [-webkit-app-region:no-drag]" />
          <DialogPrimitive.Content
            data-mode={sidebarMode}
            data-instant={layout.isHandingOver ? "" : undefined}
            data-peek={layout.floating === "peek" ? "" : undefined}
            aria-describedby={undefined}
            onPointerEnter={
              layout.floating === "peek"
                ? layout.peek.onPointerEnter
                : undefined
            }
            onPointerLeave={
              layout.floating === "peek"
                ? layout.peek.onPointerLeave
                : undefined
            }
            // Brought in by the toggle, focus starts on the place on show;
            // in from the edge, it stays where it was.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              if (layout.floating === "peek") return;
              const content = floating.current;
              const current = content?.querySelector<HTMLElement>(
                "nav [aria-current=page]",
              );
              (current ?? content?.querySelector("nav button"))?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (document.activeElement === document.body) {
                props.triggerRef.current?.focus();
              }
            }}
            style={
              props.isPlace && props.place
                ? { background: props.place.glass }
                : undefined
            }
            className="sidebar-float outline-none duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-open:animate-in data-open:slide-in-from-left-[264px] data-closed:animate-out data-closed:slide-out-to-left-[264px] data-instant:data-closed:animate-none motion-reduce:data-open:animate-none motion-reduce:data-closed:animate-none"
          >
            <DialogPrimitive.Title className="sr-only">
              Sidebar
            </DialogPrimitive.Title>
            <div ref={floating} className="contents">
              {props.sidebar(true)}
            </div>
          </DialogPrimitive.Content>
        </DialogPortal>
      </DialogPrimitive.Root>
      {props.children}
    </div>
  );
}
