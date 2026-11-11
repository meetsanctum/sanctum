import type { LucideIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { Button } from "./components/ui/button";

// An app page's title and its own buttons, in the shell's top bar as a
// dashboard's name is: the page's one primary action, or what it does and
// its way out, such as Run, Edit and Done, or an editor's Cancel and Save,
// which stay in view while it scrolls. On a phone the bar keeps the buttons
// and the title opens the page instead, where it has the width. The shell
// provides the place in its top bar; outside the shell, as in an app's
// tests, they make a header of the page's own.

/** The place in the top bar the shell gives the page on show. */
export const PageBarSlot = createContext<HTMLElement | null>(null);

export function PageBar(props: { title: string; children?: ReactNode }) {
  const slot = useContext(PageBarSlot);
  const isPhone = usePhone();
  const title = (
    <h1 className="m-0 min-w-0 truncate ps-2 text-xl leading-7 font-normal">
      {props.title}
    </h1>
  );
  const buttons = props.children && (
    <div className="ms-auto flex shrink-0 items-center gap-2 ps-3">
      {props.children}
    </div>
  );
  if (!slot) {
    return (
      <header className="flex min-h-11 shrink-0 items-center">
        {title}
        {buttons}
      </header>
    );
  }
  // Keep the buttons mounted as the title moves, so resizing preserves
  // keyboard focus and any state the page's actions hold. On the page the
  // title wraps rather than end in an ellipsis, as a room's headline does.
  return (
    <>
      {createPortal(
        <>
          {!isPhone && title}
          {buttons}
        </>,
        slot,
      )}
      {isPhone && (
        <h1 className="m-0 text-2xl leading-8 font-normal break-words">
          {props.title}
        </h1>
      )}
    </>
  );
}

/**
 * A page's button in the top bar that has an icon: the icon and its label,
 * and on a phone the icon alone in Button's bar size, named for screen
 * readers. The primary is filled; the others are ghosts like the bar's own.
 * A button that is a word alone, such as Cancel, Save or Done, stays a
 * Button.
 */
export function PageBarButton({
  icon: Icon,
  label,
  primary: isPrimary = false,
  ...props
}: { icon: LucideIcon; label: string; primary?: boolean } & Omit<
  ComponentProps<typeof Button>,
  "children" | "variant" | "size" | "asChild"
>) {
  const isPhone = usePhone();
  return (
    <Button
      {...props}
      variant={isPrimary ? "default" : isPhone ? "ghost" : "outline"}
      size={isPhone ? "bar" : "default"}
      aria-label={isPhone ? label : undefined}
    >
      <Icon aria-hidden="true" />
      {!isPhone && label}
    </Button>
  );
}

// A phone is narrower than Tailwind's `sm`, as `max-sm:` utilities have it.
const phoneQuery = "(width < 40rem)";

function subscribe(change: () => void) {
  const media = window.matchMedia?.(phoneQuery);
  media?.addEventListener("change", change);
  return () => media?.removeEventListener("change", change);
}

/** Whether the screen is a phone's, narrower than 640 px. */
export function usePhone() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia?.(phoneQuery).matches ?? false,
    () => false,
  );
}
