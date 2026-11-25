// @vitest-environment jsdom
import type { ClientInfo, Drawn, Me } from "@meetsanctum/auth-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { followStoredDrawing, useDrawing } from "../src/drawing";
import { followEffects } from "../src/effects";

// How this client draws as chosen for it: from the copy it keeps before it
// knows Me, then as Me says, telling the core what it draws with.

const stored = new Map<string, string>();
vi.mock("../src/shell", () => ({
  getShell: () => ({
    preferences: {
      get: async (key: string) => stored.get(key) ?? null,
      set: async (key: string, value: string) => void stored.set(key, value),
    },
  }),
}));
vi.mock("../src/core-fetch", () => ({
  coreJson: vi.fn(async () => undefined),
}));

const browser = "Mozilla/5.0 (Macintosh) Chrome/142.0.0.0 Safari/537.36";

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
  reduceEffects: "automatic",
  reduceMotion: "automatic",
  drawn: null,
};

let stop: () => void;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stored.clear();
  vi.mocked(coreJson).mockClear();
  stop = followEffects({
    matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
    navigator: { userAgent: browser },
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
  stored.set("drawing", JSON.stringify({ effects: "on", motion: "off" }));
  await followStoredDrawing();
  expect(html()).toMatchObject({ effects: "reduced" });
  expect(html().motion).toBeUndefined();
});

it("leaves a copy it can't read to Me", async () => {
  stored.set("drawing", '{"effects":"sometimes","motion":"on"}');
  await followStoredDrawing();
  stored.set("drawing", "not json");
  await followStoredDrawing();
  expect(html().effects).toBeUndefined();
  expect(html().motion).toBeUndefined();
});

it("draws as Me says, keeps a copy and says what it draws with once", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe(props: { me?: Me }) {
    useDrawing(props.me);
    return null;
  }
  const said = () =>
    vi
      .mocked(coreJson)
      .mock.calls.filter(([path]) => path === "/api/auth/me/drawn")
      .map(([, init]) => init?.json as Drawn);

  await act(async () => root.render(<Probe />));
  expect(said()).toEqual([]);

  const me = (changes: Partial<ClientInfo>): Me => ({
    client: { ...client, ...changes },
    person: null,
  });
  await act(async () =>
    root.render(<Probe me={me({ reduceEffects: "on", reduceMotion: "on" })} />),
  );
  expect(html()).toMatchObject({ effects: "reduced", motion: "reduced" });
  expect(JSON.parse(stored.get("drawing")!)).toEqual({
    effects: "on",
    motion: "on",
  });
  const drawn: Drawn = {
    effects: "reduced",
    motion: "reduced",
    slowDevice: false,
  };
  expect(said()).toEqual([drawn]);

  // Me saying so too starts nothing new.
  await act(async () =>
    root.render(
      <Probe me={me({ reduceEffects: "on", reduceMotion: "on", drawn })} />,
    ),
  );
  expect(said()).toEqual([drawn]);

  await act(async () =>
    root.render(
      <Probe me={me({ reduceEffects: "on", reduceMotion: "off", drawn })} />,
    ),
  );
  expect(said()).toEqual([
    drawn,
    { effects: "reduced", motion: "regular", slowDevice: false },
  ]);
  await act(async () => root.unmount());
});
