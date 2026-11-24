// @vitest-environment jsdom
import type { LightState } from "@meetsanctum/app-sdk";
import { lightColour } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { historyPage } from "../src/device-history";
import { timeText } from "../src/device-history-data";
import { lamp, lampState } from "./device-detail-fixtures";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

const now = Date.parse("2026-10-30T12:00:00Z");
const change = (minutesAgo: number, state: LightState) => ({
  at: new Date(now - minutesAgo * 60_000).toISOString(),
  availability: "online",
  state,
});
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function show(changes: ReturnType<typeof change>[], width: number) {
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(width);
  vi.mocked(coreJson).mockImplementation(async (path) => {
    const query = new URL(path, "http://core").searchParams;
    const common = {
      device: query.get("device"),
      capability: query.get("capability"),
      kind: "light",
      from: query.get("from"),
      to: query.get("to"),
      kept: true,
    };
    if (path.startsWith("/api/history/states")) {
      return { ...common, states: changes };
    }
    if (path.startsWith("/api/history/statistics")) {
      return { ...common, period: "hour", fields: { on: [], brightness: [] } };
    }
    throw new Error(`Unexpected ${path}`);
  });
  const capability = lamp.capabilities[0]!;
  if (capability.kind !== "light") throw new Error("Expected a light");
  const observed = changes.at(-1)!.state;
  await act(async () => {
    root.render(historyPage(lamp, { ...capability, observed })!.content);
  });
  return container.querySelector(
    '[aria-label="Brightness over the last 24 hours"]',
  )!;
}

it("draws many brightness changes in a few paths and lists each in one text", async () => {
  const changes = Array.from({ length: 24 }, (_, index) =>
    change(180 - index * 5, {
      ...lampState,
      on: index < 23,
      brightness: 20 + index * 2,
    }),
  );
  const strip = await show(changes, 520);
  const paths = strip.querySelectorAll("path");
  expect(paths).toHaveLength(3);
  expect(strip.querySelectorAll("rect")).toHaveLength(1);
  const [off, fill, top] = paths;
  expect(off!.getAttribute("d")).toBe("M458 87h22v1h-22z");
  expect(fill!.getAttribute("d")).toMatch(/^M420 70h2v18h-2zM422 69h1v19h-1z/);
  expect(top!.getAttribute("d")).toMatch(/^M420 70h2v2h-2zM422 69h1v2h-1z/);
  expect(fill!.getAttribute("fill")).toBe(lightColour(lampState));
  expect(top!.getAttribute("fill")).toBe(lightColour(lampState));

  const items = [...strip.parentElement!.querySelectorAll("ul > li")];
  expect(items).toHaveLength(24);
  expect(items.every((item) => item.childNodes.length === 1)).toBe(true);
  expect(items[1]!.textContent).toBe(
    `${timeText(Date.parse(changes[1]!.at))} to ${timeText(Date.parse(changes[2]!.at))}: 22%`,
  );
});

it("draws the newer colour last where two spans share a pixel", async () => {
  const red = { ...lampState, hue: 0, saturation: 100 };
  const blue = { ...red, hue: 240 };
  const strip = await show(
    [change(240, red), change(120, blue), change(119, red)],
    280,
  );
  const paths = [...strip.querySelectorAll("path")].map((path) => [
    path.getAttribute("fill"),
    path.getAttribute("d"),
  ]);
  expect(paths).toEqual([
    [lightColour(red), "M200 53h20v35h-20z"],
    [lightColour(red), "M200 53h20v2h-20z"],
    [lightColour(blue), "M220 53h1v35h-1z"],
    [lightColour(blue), "M220 53h1v2h-1z"],
    [lightColour(red), "M220 53h20v35h-20z"],
    [lightColour(red), "M220 53h20v2h-20z"],
  ]);
});
