// @vitest-environment jsdom
import { Button } from "@meetsanctum/ui-sdk";
import { act, Children, isValidElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";

import { homeDashboard, night } from "./home-shell-fixtures";
import { container, homeData, pushLive, refresh } from "./home-shell-harness";
import { light, plug } from "./place-pages-fixtures";

vi.mock(import("@meetsanctum/ui-sdk"), async (original) => {
  const actual = await original();
  return { ...actual, Button: vi.fn(actual.Button) };
});

it("redraws only the sidebar item whose status changes", async () => {
  const lamp = light("lamp", "Lamp", "kitchen", false);
  homeData.devices = [lamp, { ...plug, roomId: "kitchen" }];
  homeData.dashboards = [homeDashboard, night];
  await refresh();

  const buttons = vi.mocked(Button);
  const itemsDrawn = () =>
    buttons.mock.calls
      .filter(([props]) => props.size === "item")
      .flatMap(([props]) =>
        Children.toArray(props.children).flatMap((child) =>
          isValidElement<{ children?: ReactNode }>(child) &&
          typeof child.props.children === "string"
            ? [child.props.children]
            : [],
        ),
      );
  expect(itemsDrawn()).toEqual(
    expect.arrayContaining(["Lights", "Switches", "Kitchen", "Home", "Night"]),
  );
  expect(
    container.querySelector('nav button[aria-label="Lights, All off"]'),
  ).not.toBeNull();
  buttons.mockClear();

  await act(async () => {
    pushLive({
      type: "device",
      id: lamp.id,
      device: light(lamp.id, lamp.name, lamp.roomId, true),
    });
  });
  expect(
    container.querySelector('nav button[aria-label="Lights, 1 on"]'),
  ).not.toBeNull();
  expect(itemsDrawn()).toEqual(["Lights", "1 on"]);
});
