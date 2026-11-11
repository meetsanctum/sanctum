import { useEffect, useRef } from "react";

// While a key steps a slider, a value goes out at most this often, in ms.
const sendEvery = 300;

// Sends the latest value now, then at most once per `sendEvery` while it
// keeps changing: a tile's brightness slider, and a light's controls in
// its detail, as keys step them.
export function useThrottledSend<T>(
  send: (value: T) => void,
  isEnabled: boolean,
) {
  const latest = useRef(send);
  // Only a committed render's value may be sent.
  useEffect(() => {
    latest.current = send;
  });
  const state = useRef<{
    timer?: ReturnType<typeof setTimeout>;
    sentAt?: number;
    next?: { value: T };
  }>({});
  useEffect(
    () => () => {
      clearTimeout(state.current.timer);
      state.current = {};
    },
    [isEnabled],
  );

  const flushNow = () => {
    const { next } = state.current;
    clearTimeout(state.current.timer);
    state.current.timer = undefined;
    state.current.next = undefined;
    if (isEnabled && next !== undefined) {
      state.current.sentAt = Date.now();
      latest.current(next.value);
    }
  };
  const push = (value: T) => {
    state.current.next = { value };
    if (state.current.timer !== undefined) return;
    const elapsed = Date.now() - (state.current.sentAt ?? -Infinity);
    if (elapsed >= sendEvery) flushNow();
    else state.current.timer = setTimeout(flushNow, sendEvery - elapsed);
  };
  const flush = () => {
    flushNow();
    state.current = {};
  };
  return { send: push, flush };
}
