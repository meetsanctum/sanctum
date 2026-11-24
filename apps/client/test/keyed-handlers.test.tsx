// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useKeyedHandlers } from "../src/keyed-handlers";

// A list's items get the same function for each key on every render, which
// calls what the page says now.

let root: Root;
let container: HTMLDivElement;
let handlers: ((key: string) => () => void) | undefined;

function List(props: { onSelect: (key: string) => void }) {
  handlers = useKeyedHandlers(props.onSelect);
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("keeps each key's function and calls the latest handler", async () => {
  const first = vi.fn();
  const second = vi.fn();
  await act(async () => root.render(<List onSelect={first} />));
  const kitchen = handlers!("kitchen");
  expect(handlers!("kitchen")).toBe(kitchen);
  expect(handlers!("office")).not.toBe(kitchen);

  await act(async () => root.render(<List onSelect={second} />));
  expect(handlers!("kitchen")).toBe(kitchen);
  kitchen();
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledWith("kitchen");
});
