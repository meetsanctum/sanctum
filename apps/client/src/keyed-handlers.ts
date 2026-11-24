import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A function for each key that keeps its identity across renders and calls
 * the latest `handler` with its key: a list's items, such as the sidebar's,
 * then get the same `onSelect` each time and aren't drawn again for it,
 * while a press still does what the page says now.
 */
export function useKeyedHandlers<Key>(handler: (key: Key) => void) {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  const made = useRef(new Map<Key, () => void>());
  return useCallback((key: Key) => {
    let each = made.current.get(key);
    if (!each) {
      each = () => latest.current(key);
      made.current.set(key, each);
    }
    return each;
  }, []);
}
