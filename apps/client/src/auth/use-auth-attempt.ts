import { useCallback, useEffect, useRef } from "react";

// Leaving a form cancels its exchange and any pending credential save.
export function useAuthAttempt() {
  const controller = useRef<AbortController | null>(null);
  const cancel = useCallback(() => controller.current?.abort(), []);
  useEffect(() => cancel, [cancel]);
  return {
    cancel,
    start() {
      cancel();
      controller.current = new AbortController();
      return controller.current.signal;
    },
  };
}
