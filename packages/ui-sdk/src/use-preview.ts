import { useCallback, useEffect, useRef, useState } from "react";

// How long a dragged or stepped value shows before the light's own state
// takes over again, if no answer changes it first, in ms.
const holdPreview = 3_000;

// What a drag or a key on a light's control has reached, shown in place of
// the light's own state until that changes (`follow`), a command to it
// fails (`failures` goes up) or `holdPreview` passes once it went out.
export function usePreview<T>(follow: string, failures = 0) {
  const [value, setValue] = useState<T | null>(null);
  const holding = useRef<ReturnType<typeof setTimeout>>(undefined);
  // A drag still going keeps its preview whatever the light does.
  const dragging = useRef(false);

  useEffect(() => {
    if (!dragging.current) setValue(null);
  }, [follow]);
  const seen = useRef(failures);
  useEffect(() => {
    if (failures <= seen.current) return;
    seen.current = failures;
    if (!dragging.current) {
      clearTimeout(holding.current);
      setValue(null);
    }
  }, [failures]);
  useEffect(() => () => clearTimeout(holding.current), []);

  const clear = useCallback(() => {
    dragging.current = false;
    clearTimeout(holding.current);
    setValue(null);
  }, []);

  return {
    value,
    /** Shows a drag's value until it ends. */
    drag(next: T) {
      dragging.current = true;
      clearTimeout(holding.current);
      setValue(next);
    },
    /** Shows a value that went out until the light answers. */
    hold(next: T) {
      dragging.current = false;
      clearTimeout(holding.current);
      setValue(next);
      holding.current = setTimeout(() => setValue(null), holdPreview);
    },
    /** Goes back to the light's own state. */
    clear,
  };
}
