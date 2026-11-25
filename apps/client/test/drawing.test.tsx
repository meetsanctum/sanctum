// @vitest-environment jsdom
import type {
  ClientInfo,
  Drawn,
  Me,
  ReportClientDrawing,
} from "@meetsanctum/auth-protocol";
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
  drawingRevision: 0,
  drawn: null,
};

const me = (changes: Partial<ClientInfo>): Me => ({
  client: { ...client, ...changes },
  person: null,
});

function Probe(props: { me?: Me }) {
  useDrawing(props.me);
  return null;
}

const said = () =>
  vi
    .mocked(coreJson)
    .mock.calls.filter(([path]) => path === "/api/auth/me/drawn")
    .map(([, init]) => init?.json as ReportClientDrawing);

let stop: () => void;
let motion: EventTarget & { matches: boolean };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stored.clear();
  vi.mocked(coreJson).mockReset();
  motion = Object.assign(new EventTarget(), { matches: false });
  stop = followEffects({
    matchMedia: (query: string) =>
      query.includes("reduced-motion")
        ? motion
        : Object.assign(new EventTarget(), { matches: false }),
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
  await act(async () => root.render(<Probe />));
  expect(said()).toEqual([]);

  const choices = {
    reduceEffects: "on",
    reduceMotion: "on",
    drawingRevision: 1,
  } as const;
  await act(async () => root.render(<Probe me={me(choices)} />));
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
  const first = { ...drawn, drawingRevision: 1 };
  expect(said()).toEqual([first]);

  // Me saying so too starts nothing new.
  await act(async () => root.render(<Probe me={me({ ...choices, drawn })} />));
  expect(said()).toEqual([first]);

  await act(async () =>
    root.render(
      <Probe
        me={me({ ...choices, reduceMotion: "off", drawingRevision: 2 })}
      />,
    ),
  );
  const second = { ...first, motion: "regular", drawingRevision: 2 };
  expect(said()).toEqual([first, second]);

  // A new choice can resolve to the same appearance.
  await act(async () =>
    root.render(
      <Probe
        me={me({ ...choices, reduceMotion: "automatic", drawingRevision: 3 })}
      />,
    ),
  );
  expect(said()).toEqual([first, second, { ...second, drawingRevision: 3 }]);
  await act(async () => root.unmount());
});

it("sends one report at a time and retries a failed report on refresh", async () => {
  const root = createRoot(document.createElement("div"));
  let finishFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  vi.mocked(coreJson).mockReturnValueOnce(first);
  await act(async () => root.render(<Probe me={me({})} />));
  const regular = {
    drawingRevision: 0,
    effects: "regular",
    motion: "regular",
    slowDevice: false,
  };
  expect(said()).toEqual([regular]);

  motion.matches = true;
  motion.dispatchEvent(new Event("change"));
  expect(said()).toEqual([regular]);

  vi.mocked(coreJson).mockRejectedValueOnce(new Error("Offline"));
  await act(async () => finishFirst());
  const reduced = { ...regular, motion: "reduced" };
  expect(said()).toEqual([regular, reduced]);

  await act(async () => root.render(<Probe me={me({})} />));
  expect(said()).toEqual([regular, reduced, reduced]);
  await act(async () => root.unmount());
});
