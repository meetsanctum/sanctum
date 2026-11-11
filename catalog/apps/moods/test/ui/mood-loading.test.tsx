// @vitest-environment jsdom
import { AppScope } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Mood } from "../../src/ui/mood-draft";
import { useMoods } from "../../src/ui/moods";
import { fakeClient } from "./support";

const mood: Mood = {
  id: "relax",
  roomId: "office",
  name: "Relax",
  icon: "moon",
  smart: null,
  lights: [{ device: "lamp", capability: "light", state: { on: true } }],
};
let root: Root;
let container: HTMLDivElement;
let client: ReturnType<typeof fakeClient>;
let state: ReturnType<typeof useMoods>;
function Probe() {
  state = useMoods();
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client = fakeClient();
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root.render(
      <AppScope client={client}>
        <Probe />
      </AppScope>,
    );
  });
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  vi.unstubAllGlobals();
});

it("keeps a saved mood when an older refresh finishes afterwards", async () => {
  const old = deferred<Mood[]>();
  client.call.mockImplementation((action) =>
    action === "moods.moods" ? old.promise : Promise.resolve(mood),
  );
  const loading = state.load();
  await act(async () => {
    await state.save(mood);
  });
  await act(async () => {
    old.resolve([]);
    await loading;
  });
  expect(state.moods).toEqual([mood]);
});

it("retains other moods when saving before the initial load finishes", async () => {
  const initial = deferred<Mood[]>();
  const other = { ...mood, id: "work", name: "Work" };
  client.call.mockImplementation((action) =>
    action === "moods.moods" ? initial.promise : Promise.resolve(mood),
  );
  const loading = state.load();
  await act(async () => {
    await state.save(mood);
  });
  await act(async () => {
    initial.resolve([other]);
    await loading;
  });
  expect(state.moods).toEqual([other, mood]);
});

it("does not resurrect a deleted mood from an older refresh", async () => {
  client.call.mockResolvedValue([mood]);
  await act(async () => {
    await state.load();
  });
  const old = deferred<Mood[]>();
  client.call.mockImplementation((action) =>
    action === "moods.moods" ? old.promise : Promise.resolve({ id: mood.id }),
  );
  const loading = state.load();
  await act(async () => {
    await state.remove(mood.id);
  });
  await act(async () => {
    old.resolve([mood]);
    await loading;
  });
  expect(state.moods).toEqual([]);
});

it("keeps the newest refresh when responses arrive out of order", async () => {
  const old = deferred<Mood[]>();
  client.call.mockReturnValueOnce(old.promise).mockResolvedValueOnce([mood]);
  const loading = state.load();
  await act(async () => {
    await state.load();
  });
  await act(async () => {
    old.resolve([]);
    await loading;
  });
  expect(state.moods).toEqual([mood]);
});
