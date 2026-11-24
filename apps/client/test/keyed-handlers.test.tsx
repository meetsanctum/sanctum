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

function List(props: { onSelect: (key: string) => void; keys: string[] }) {
  handlers = useKeyedHandlers(props.onSelect, props.keys);
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

it("keeps current keys' functions, releases removed keys, and calls the latest handler", async () => {
  const first = vi.fn();
  const second = vi.fn();
  const keys = ["kitchen", "office"];
  await act(async () => root.render(<List onSelect={first} keys={keys} />));
  const kitchen = handlers!("kitchen");
  const office = handlers!("office");
  expect(handlers!("kitchen")).toBe(kitchen);
  expect(office).not.toBe(kitchen);

  await act(async () =>
    root.render(<List onSelect={second} keys={["kitchen"]} />),
  );
  expect(handlers!("kitchen")).toBe(kitchen);
  kitchen();
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledWith("kitchen");

  await act(async () => root.render(<List onSelect={second} keys={keys} />));
  expect(handlers!("office")).not.toBe(office);
});
