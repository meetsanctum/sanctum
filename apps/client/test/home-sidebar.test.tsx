// @vitest-environment jsdom
import { Button } from "@meetsanctum/ui-sdk";
import { act, Children, isValidElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";

import { homeDashboard, night } from "./home-shell-fixtures";
import {
  container,
  homeData,
  mockCoreJson,
  pageTitle,
  pushLive,
  refresh,
  remountHome,
} from "./home-shell-harness";
import { light, plug } from "./place-pages-fixtures";

vi.mock(import("@meetsanctum/ui-sdk"), async (original) => {
  const actual = await original();
  return { ...actual, Button: vi.fn(actual.Button) };
});

it("opens the signed-in person's profile from the floating sidebar and goes back to People", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  await import("../src/settings");
  const maya = { id: "maya", name: "Maya", avatar: null, colour: "#c5cdac" };
  const sam = { id: "sam", name: "Sam", avatar: null, colour: "#fcd2b3" };
  const original = mockCoreJson.getMockImplementation()!;
  mockCoreJson.mockImplementation(async (path, init) => {
    switch (path) {
      case "/api/auth/me":
        return { client: { kind: "personal" }, person: maya };
      case "/api/people":
        return [sam, maya];
      case "/api/auth/logins":
        return [{ personId: maya.id, username: "maya" }];
      case "/api/auth/invites":
      case "/api/auth/clients":
      case "/api/auth/agents":
        return [];
      default:
        return original(path, init);
    }
  });
  await remountHome();

  const toggle = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Show the sidebar"]',
  )!;
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const account = document.querySelector<HTMLButtonElement>(
    '.sidebar-float button[aria-label="Maya\'s menu"]',
  )!;
  await act(async () =>
    account.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  const profile = [
    ...document.querySelectorAll<HTMLElement>("[role=menuitem]"),
  ].find((item) => item.textContent === "Profile")!;
  await act(async () => profile.click());

  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector(".sidebar-float")).toBeNull();
  expect(pageTitle()).toBe("Maya");
  const back = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Back to People"]',
  )!;
  await act(async () => back.click());
  expect(pageTitle()).toBe("People");
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
