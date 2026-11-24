// @vitest-environment jsdom
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { lazyPage } from "../src/lazy-page";

// A page that loads the first time it opens, and once loaded draws at once.

let root: Root;
let container: HTMLDivElement;

function Greeting(props: { name: string }) {
  return <p>Hello {props.name}</p>;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("waits for its module the first time, showing what it falls back on", async () => {
  let resolve!: (page: typeof Greeting) => void;
  const load = vi.fn(
    () => new Promise<typeof Greeting>((done) => (resolve = done)),
  );
  const { Page } = lazyPage(load);

  await act(async () => {
    root.render(
      <Suspense fallback={<p>Loading</p>}>
        <Page name="Sam" />
      </Suspense>,
    );
  });
  expect(container.textContent).toBe("Loading");

  await act(async () => resolve(Greeting));
  expect(container.textContent).toBe("Hello Sam");
  expect(load).toHaveBeenCalledTimes(1);
});

it("draws at once, never falling back, once preloaded", async () => {
  const { Page, preload } = lazyPage(async () => Greeting);
  await preload();
  const fallback = vi.fn(() => <p>Loading</p>);
  function Fallback() {
    return fallback();
  }

  act(() => {
    root.render(
      <Suspense fallback={<Fallback />}>
        <Page name="Sam" />
      </Suspense>,
    );
  });

  expect(container.textContent).toBe("Hello Sam");
  expect(fallback).not.toHaveBeenCalled();
});
