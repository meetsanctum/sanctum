// @vitest-environment jsdom
import type { ClientInfo, Me } from "@meetsanctum/auth-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { followStoredDrawing, useDrawing } from "../src/drawing";
import { followEffects } from "../src/effects";

// How this client draws as set for it: from the copy it keeps before it
// knows Me, then as Me says.

const stored = new Map<string, string>();
vi.mock("../src/shell", () => ({
  getShell: () => ({
    preferences: {
      get: async (key: string) => stored.get(key) ?? null,
      set: async (key: string, value: string) => void stored.set(key, value),
    },
  }),
}));

const client: ClientInfo = {
  id: "display",
  name: "Office Display",
  kind: "shared",
  platform: "android",
  personId: null,
  createdAt: "2026-11-25T08:00:00Z",
  lastSeenAt: null,
  connectedSince: null,
  current: true,
  reduceEffects: false,
  reduceMotion: false,
};

const me = (changes: Partial<ClientInfo>): Me => ({
  client: { ...client, ...changes },
  person: null,
});

function Probe(props: { me?: Me }) {
  useDrawing(props.me);
  return null;
}

let stop: () => void;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stored.clear();
  stop = followEffects({
    location: { search: "" },
    document,
  } as unknown as Window);
});
afterEach(() => {
  stop();
  delete document.documentElement.dataset.effects;
  delete document.documentElement.dataset.motion;
  vi.unstubAllGlobals();
});

const html = () => ({ ...document.documentElement.dataset });

it("draws as its kept copy says before it knows Me", async () => {
  stored.set(
    "drawing",
    JSON.stringify({ reduceEffects: true, reduceMotion: false }),
  );
  await followStoredDrawing();
  expect(html()).toMatchObject({ effects: "reduced" });
  expect(html().motion).toBeUndefined();
});

it("leaves a copy it can't read to Me", async () => {
  stored.set("drawing", '{"effects":"on","motion":"on"}');
  await followStoredDrawing();
  stored.set("drawing", '{"reduceEffects":"yes","reduceMotion":true}');
  await followStoredDrawing();
  stored.set("drawing", "not json");
  await followStoredDrawing();
  expect(html().effects).toBeUndefined();
  expect(html().motion).toBeUndefined();
});

it("draws as Me says and keeps a copy", async () => {
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  expect(stored.has("drawing")).toBe(false);

  await act(async () =>
    root.render(<Probe me={me({ reduceEffects: true, reduceMotion: true })} />),
  );
  expect(html()).toMatchObject({ effects: "reduced", motion: "reduced" });
  expect(JSON.parse(stored.get("drawing")!)).toEqual({
    reduceEffects: true,
    reduceMotion: true,
  });

  await act(async () =>
    root.render(
      <Probe me={me({ reduceEffects: true, reduceMotion: false })} />,
    ),
  );
  expect(html()).toMatchObject({ effects: "reduced" });
  expect(html().motion).toBeUndefined();
  expect(JSON.parse(stored.get("drawing")!)).toEqual({
    reduceEffects: true,
    reduceMotion: false,
  });
  await act(async () => root.unmount());
});

it("leaves the look as it is where Me says something other than on or off", async () => {
  const root = createRoot(document.createElement("div"));
  const old = { reduceEffects: "automatic", reduceMotion: "automatic" };
  await act(async () =>
    root.render(<Probe me={me(old as unknown as Partial<ClientInfo>)} />),
  );
  expect(html().effects).toBeUndefined();
  expect(stored.has("drawing")).toBe(false);
  await act(async () => root.unmount());
});
