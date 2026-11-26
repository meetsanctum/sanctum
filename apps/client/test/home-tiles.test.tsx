// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";

import { useShowFailed } from "../../../packages/ui-sdk/src/show-failed";
import { homeDashboard } from "./home-shell-fixtures";
import { container, homeData, pushLive, refresh } from "./home-shell-harness";
import { light } from "./settings-devices-fixtures";

vi.mock(
  import("../../../packages/ui-sdk/src/show-failed"),
  async (original) => {
    const actual = await original();
    return { ...actual, useShowFailed: vi.fn(actual.useShowFailed) };
  },
);

it("redraws only the tile whose device changes on Home", async () => {
  const lamp = light("lamp", "Lamp", { roomId: "kitchen" });
  const ceiling = light("ceiling", "Ceiling", { roomId: "kitchen" });
  homeData.devices = [lamp, ceiling];
  homeData.dashboards = [
    { ...homeDashboard, kind: "home", devices: [lamp.id, ceiling.id] },
  ];
  await refresh();

  const renders = vi.mocked(useShowFailed);
  // DeviceTile passes a failure callback when it renders.
  const tileRenders = () =>
    renders.mock.calls.filter(([, callback]) => callback);
  // The two lights, and the kitchen's Lights tile.
  expect(tileRenders()).toHaveLength(3);
  expect(
    container.querySelector('main [aria-label="Lamp, Off"]'),
  ).not.toBeNull();
  expect(
    container.querySelector('main [aria-label="Ceiling, Off"]'),
  ).not.toBeNull();
  renders.mockClear();

  await act(async () => {
    pushLive({
      type: "device",
      id: lamp.id,
      device: { ...lamp, name: "Desk Lamp" },
    });
  });
  expect(
    container.querySelector('main [aria-label="Desk Lamp, Off"]'),
  ).not.toBeNull();
  expect(tileRenders()).toHaveLength(1);
});
