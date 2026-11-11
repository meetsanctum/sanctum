import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
} from "react";

import { getShell } from "./shell";

// Where the sidebar is. Where the window is wide enough it docks beside the
// page, unless this device collapsed it, which it remembers. Collapsed, or
// where the window is too narrow to dock, it floats over the page: the
// toggle brings it in, and where a pointer can hover, so does resting on the
// window's left edge, which leaves it again once the pointer does. The macOS
// traffic lights go with it, and View's Show sidebar or Hide sidebar (⌃⌘S)
// does what the toggle does.

// Wide enough to dock: the page keeps about 700 px beside it.
const dockQuery = "(min-width: 960px)";
// A pointer that hovers can bring it in from the left edge.
const hoverQuery = "(hover: hover) and (pointer: fine)";
const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

// The sidebar's width, how far it and the traffic lights slide as it docks
// or collapses, over 300 ms (shell-frame.css). Floating, it slides 264 px,
// out of its inset (shell-frame.tsx).
const sidebarWidth = 248;
const floatingSlide = 264;
const slideMs = 300;
// Resting on the edge this long brings it in, moving along it starting
// again, and leaving it this long takes it away, so passing by does
// neither. Once it has gone, the edge waits a moment before it brings it
// again, so a pointer resting there does not bring it back and forth.
const peekInMs = 200;
const peekOutMs = 300;
const peekAgainMs = 500;

const preferenceKey = "sidebar";

function useMedia(query: string, fallback: boolean) {
  return useSyncExternalStore(
    (change) => {
      const media = window.matchMedia?.(query);
      media?.addEventListener("change", change);
      return () => media?.removeEventListener("change", change);
    },
    () => window.matchMedia?.(query).matches ?? fallback,
    () => fallback,
  );
}

/** How the sidebar floats over the page: in from the edge, or brought in by the toggle. */
export type Floating = "peek" | "open" | null;

export function useSidebarLayout(isVeiled = false) {
  const canDock = useMedia(dockQuery, true);
  const canHover = useMedia(hoverQuery, false);
  const reducedMotion = useMedia(reducedMotionQuery, false);
  // Docked until this device's choice is read.
  const [collapsed, setCollapsed] = useState(false);
  const [floating, setFloating] = useState<Floating>(null);
  // As the toggle docks or collapses it, the page's left edge goes with it
  // and its right edge stays (shell-frame.css); at once otherwise, as when
  // this device's choice is read or the window narrows.
  const [isSliding, setSliding] = useState(false);
  const slideEnd = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Docked from the floating sidebar, the one takes the other's place at
  // once, so the two do not cross; only the page slides.
  const [isHandingOver, setHandingOver] = useState(false);
  const handOver = useRef<ReturnType<typeof setTimeout>>(undefined);
  const peekIn = useRef<ReturnType<typeof setTimeout>>(undefined);
  const peekOut = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isInside = useRef(false);
  const isHeld = useRef(false);
  const docked = canDock && !collapsed;
  const cancelPeek = useCallback(() => {
    clearTimeout(peekIn.current);
    clearTimeout(peekOut.current);
  }, []);
  const close = useCallback(() => {
    cancelPeek();
    isInside.current = false;
    isHeld.current = false;
    setFloating(null);
  }, [cancelPeek]);

  useEffect(() => {
    let isStopped = false;
    getShell()
      .preferences.get(preferenceKey)
      .then(
        (kept) => {
          if (!isStopped && kept === "collapsed") setCollapsed(true);
        },
        () => undefined,
      );
    return () => {
      isStopped = true;
    };
  }, []);

  const keep = (next: boolean) => {
    setCollapsed(next);
    // Where it cannot be kept, it is remembered until the app restarts.
    getShell()
      .preferences.set(preferenceKey, next ? "collapsed" : "docked")
      .catch(() => undefined);
  };
  // A frame or two past the slide, so a busy first frame, which starts it
  // late, does not cut its end short.
  const slide = () => {
    if (reducedMotion) return;
    clearTimeout(slideEnd.current);
    setSliding(true);
    slideEnd.current = setTimeout(() => setSliding(false), slideMs + 50);
  };
  // A window that can no longer dock, or a change to reduced motion,
  // ends the slide without carrying it into the next layout.
  useEffect(() => {
    if (canDock && !reducedMotion) return;
    clearTimeout(slideEnd.current);
    setSliding(false);
  }, [canDock, reducedMotion]);

  const dock = () => {
    close();
    if (!collapsed) return;
    slide();
    keep(false);
  };
  const collapse = () => {
    close();
    slide();
    keep(true);
  };

  // The top bar's toggle and ⌃⌘S: docked, it collapses; collapsed, it docks
  // again; too narrow to dock, it brings the sidebar in over the page, and
  // takes it away.
  const toggle = () => {
    if (isVeiled) return;
    if (!canDock) {
      if (floating === "open") close();
      else {
        cancelPeek();
        setFloating("open");
      }
    } else if (docked) {
      collapse();
    } else {
      dock();
    }
  };
  const toggleRef = useRef(toggle);
  useEffect(() => {
    toggleRef.current = toggle;
  });

  // Docked, nothing floats.
  useEffect(() => {
    if (docked || isVeiled) close();
  }, [docked, isVeiled, close]);

  // In from the window's left edge, and away again.
  const goneAt = useRef(0);
  const wasPeeking = useRef(false);
  useEffect(() => {
    if (wasPeeking.current && floating !== "peek") goneAt.current = Date.now();
    wasPeeking.current = floating === "peek";
  }, [floating]);
  useEffect(
    () => () => {
      clearTimeout(peekIn.current);
      clearTimeout(peekOut.current);
      clearTimeout(handOver.current);
      clearTimeout(slideEnd.current);
    },
    [],
  );
  const leaveSoon = useCallback(() => {
    clearTimeout(peekOut.current);
    peekOut.current = setTimeout(
      () => setFloating((now) => (now === "peek" ? null : now)),
      peekOutMs,
    );
  }, []);
  function restOnEdge(event: PointerEvent) {
    if (event.pointerType !== "mouse") return;
    clearTimeout(peekIn.current);
    if (Date.now() - goneAt.current < peekAgainMs) return;
    // Only a closed sidebar peeks: one the toggle opened meanwhile stays.
    peekIn.current = setTimeout(
      () => setFloating((now) => (now === null ? "peek" : now)),
      peekInMs,
    );
  }
  const edge =
    !isVeiled && !docked && floating === null && canHover
      ? {
          onPointerEnter: restOnEdge,
          onPointerMove: restOnEdge,
          onPointerLeave() {
            clearTimeout(peekIn.current);
          },
        }
      : undefined;
  const peek = {
    onPointerEnter() {
      isInside.current = true;
      clearTimeout(peekOut.current);
    },
    onPointerLeave() {
      isInside.current = false;
      if (!isHeld.current) leaveSoon();
    },
  };
  // A menu opened from it, such as the account's, keeps it in.
  const hold = useCallback(
    (isOpen: boolean) => {
      isHeld.current = isOpen;
      if (isOpen) {
        clearTimeout(peekOut.current);
      } else if (!isInside.current) {
        leaveSoon();
      }
    },
    [leaveSoon],
  );

  // The traffic lights go with the sidebar, sliding in and out with it as
  // far as it moves, which the desktop app does since the system draws them;
  // the first time, and where motion is reduced, at once. An overlay hides
  // them for as long as it covers the window, at once too, since nothing
  // slides then. View's item names what ⌃⌘S does.
  const [isCovered, setCovered] = useState(false);
  const lightsWanted = (docked || floating !== null) && !isCovered;
  // Whether they show, none at first, which sidebar brought them, and
  // whether an overlay covered them last time.
  const lightsShown = useRef<boolean | null>(null);
  const lightsWith = useRef<"docked" | "floating" | null>(null);
  const wasCovered = useRef(false);
  useEffect(() => {
    const showing = docked ? "docked" : floating !== null ? "floating" : null;
    const moving = showing ?? lightsWith.current;
    if (showing) lightsWith.current = showing;
    const coverChanged = wasCovered.current !== isCovered;
    wasCovered.current = isCovered;
    const before = lightsShown.current;
    // A new cover must stop a slide already heading out, even though its
    // target is hidden too.
    if (before === lightsWanted && !(coverChanged && isCovered)) return;
    lightsShown.current = lightsWanted;
    const by =
      before === null || reducedMotion || coverChanged
        ? 0
        : moving === "floating"
          ? floatingSlide
          : sidebarWidth;
    void getShell()
      .window?.setControls(lightsWanted, by)
      .catch(() => undefined);
  }, [docked, floating, isCovered, lightsWanted, reducedMotion]);
  const canHideSidebar = docked || (!canDock && floating === "open");
  useEffect(() => {
    void getShell()
      .window?.setSidebar(isVeiled ? null : canHideSidebar ? "shown" : "hidden")
      .catch(() => undefined);
  }, [canHideSidebar, isVeiled]);
  useEffect(() => {
    const unsubscribe = getShell().window?.onToggleSidebar(() =>
      toggleRef.current(),
    );
    return () => {
      unsubscribe?.();
      // The screens before the home show the lights and have no sidebar.
      const controls = getShell().window;
      void controls?.setControls(true).catch(() => undefined);
      void controls?.setSidebar(null).catch(() => undefined);
    };
  }, []);

  return {
    /** Beside the page, in the layout. */
    docked,
    /** The page's left edge is going with the sidebar as the toggle docks or collapses it. */
    isSliding,
    floating,
    /** Wide enough to dock: the floating sidebar's toggle docks it then. */
    canDock,
    toggle,
    /** Docked from the floating sidebar: neither slides. */
    isHandingOver,
    /** The floating sidebar's own toggle: it docks where it can, or goes. */
    keepShown: () => {
      if (!canDock) {
        close();
        return;
      }
      clearTimeout(handOver.current);
      setHandingOver(true);
      handOver.current = setTimeout(() => setHandingOver(false), slideMs);
      dock();
    },
    /** Takes the floating sidebar away, as choosing a place in it does. */
    close,
    /** The window's left edge, while resting on it can bring the sidebar in. */
    edge,
    /** The floating sidebar brought in from the edge. */
    peek,
    hold,
    /** Says an overlay has come over the window, or has gone. */
    setCovered,
  };
}

export type SidebarLayout = ReturnType<typeof useSidebarLayout>;
