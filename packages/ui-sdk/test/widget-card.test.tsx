// @vitest-environment jsdom
import type { TemperatureUnit, WidgetContent } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HomeTimeZoneProvider } from "../src/home-time-zone";
import { TemperatureUnitProvider } from "../src/temperature-unit";
import {
  WidgetCard,
  formatWidgetValue,
  type RunWidgetAction,
} from "../src/widget-card";

// A widget's card as the shell draws it: what its app shows, with values
// written in the household's unit, the home's time zone and this device's
// language, and the rows' checks and the button running the app's actions.

const celsius = { unit: "celsius" as const, timeZone: "Europe/Zurich" };

describe("a card's values", () => {
  it.each([
    [{ temperature: 8.2 }, "8°"],
    [{ temperature: -0.3 }, "0°"],
    ["Partly cloudy", "Partly cloudy"],
    [{ percent: 3.4 }, "3%"],
    [{ number: 320, unit: "lux" as const }, "320 lx"],
    [{ number: 2 }, "2"],
  ])("writes %j as %s", (value, text) => {
    expect(formatWidgetValue(value, celsius)).toBe(text);
  });

  it("writes temperatures in the household's unit", () => {
    expect(
      formatWidgetValue(
        { temperature: 8.2 },
        { ...celsius, unit: "fahrenheit" },
      ),
    ).toBe("47°");
  });

  it("writes times in the home's time zone, and days as the day they are", () => {
    const time = { time: "2026-11-03T06:04:00Z" };
    expect(formatWidgetValue(time, celsius)).toMatch(/^0?7:04/);
    expect(
      formatWidgetValue(time, { ...celsius, timeZone: "America/New_York" }),
    ).toMatch(/^0?1:04/);
    // A day is the same day wherever the home is.
    for (const timeZone of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      expect(
        formatWidgetValue({ date: "2026-11-04" }, { ...celsius, timeZone }),
      ).toBe(
        new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
          new Date(2026, 10, 4),
        ),
      );
    }
    expect(formatWidgetValue({ date: "2026-11-04", as: "day" }, celsius)).toBe(
      new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
      }).format(new Date(2026, 10, 4)),
    );
  });
});

const list: WidgetContent = {
  blocks: [
    { kind: "headline", value: "2 items" },
    {
      kind: "line",
      text: "For {day}",
      values: { day: { date: "2026-11-04", as: "day" } },
    },
    {
      kind: "rows",
      items: [
        {
          text: "First item",
          detail: "Maya",
          value: { number: 2 },
          check: {
            checked: false,
            action: "example.tick",
            input: { item: "milk" },
          },
        },
        {
          text: "Bread",
          check: {
            checked: true,
            action: "example.tick",
            input: { item: "bread" },
          },
        },
      ],
    },
    { kind: "action", label: "Add item", page: "add" },
  ],
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(
  content: WidgetContent | null,
  handlers: {
    run?: RunWidgetAction;
    open?: (page: string) => void;
    unavailable?: string;
  } = {},
  unit: TemperatureUnit | "unknown" = "celsius",
) {
  await act(async () => {
    root.render(
      <TemperatureUnitProvider unit={unit === "unknown" ? undefined : unit}>
        <HomeTimeZoneProvider timeZone="Europe/Zurich">
          <WidgetCard
            title="Board"
            color="leaf"
            size={{ columns: 4, rows: 4 }}
            content={content}
            {...handlers}
          />
        </HomeTimeZoneProvider>
      </TemperatureUnitProvider>,
    );
  });
  return container.querySelector("article")!;
}

describe("a card", () => {
  it("is titled in its app's colour and takes its size on the grid", async () => {
    const card = await render(list);

    expect(card.getAttribute("aria-labelledby")).toBe(
      card.querySelector("h2")?.id,
    );
    expect(card.querySelector("h2")?.textContent).toBe("Board");
    expect(card.querySelector("h2")?.style.color).toBe("var(--leaf-text)");
    expect(card.style.gridColumn).toBe("span 4 / span 4");
    expect(card.style.gridRow).toBe("span 4 / span 4");
  });

  it("shows only its title until it has content and the unit is known", async () => {
    expect((await render(null)).textContent).toBe("Board");
    expect((await render(list, {}, "unknown")).textContent).toBe("Board");
  });

  it("shows its blocks in the app's order, its line close under its headline", async () => {
    const card = await render(list);

    expect(card.textContent).toContain("2 items");
    expect(card.querySelector("p")?.parentElement?.className).toContain(
      "gap-1",
    );
    expect(
      [...card.querySelectorAll("li")].map((each) => each.textContent),
    ).toEqual(["First itemMaya2", "Bread"]);
    expect(
      [...card.querySelectorAll('[role="checkbox"]')].map((each) => [
        each.getAttribute("aria-label"),
        each.getAttribute("aria-checked"),
      ]),
    ).toEqual([
      ["First item", "false"],
      ["Bread", "true"],
    ]);
    expect(card.querySelector("button:last-child")?.textContent).toBe(
      "Add item",
    );
  });

  it("runs a check's action with its input, and opens the button's page", async () => {
    const run = vi.fn(async () => ({}));
    const open = vi.fn();
    const card = await render(list, { run, open });

    await act(async () =>
      card.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click(),
    );
    await act(async () => [...card.querySelectorAll("button")].at(-1)!.click());

    expect(run).toHaveBeenCalledWith("example.tick", { item: "milk" });
    expect(open).toHaveBeenCalledWith("add");
  });

  it("runs the button's action, once until it settles, and shakes when it fails", async () => {
    let fail!: (error: Error) => void;
    const run = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const card = await render(
      {
        blocks: [
          { kind: "action", label: "Water now", action: "plants.water" },
        ],
      },
      { run },
    );
    const button = card.querySelector("button")!;
    const animate = vi.fn();
    button.animate = animate;

    await act(async () => button.click());
    await act(async () => button.click());
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("plants.water", {});

    await act(async () => fail(new Error("unavailable")));
    expect(animate).toHaveBeenCalled();
  });

  it("says beside its title why it can't be used, and dims what it shows, which nothing presses", async () => {
    const run = vi.fn(async () => ({}));
    const card = await render(list, { run, unavailable: "Paused" });

    expect(card.querySelector("h2")?.textContent).toBe("Board, Paused");
    // Heard as it changes, not only when a screen reader reaches the title.
    expect(card.querySelector('[role="status"]')?.textContent).toBe(
      "Board, Paused",
    );
    const shown = card.querySelector<HTMLElement>("[inert]")!;
    expect(shown.className).toContain("opacity-50");
    expect(shown.textContent).toContain("First item");
    expect(shown.querySelector("button:last-child")?.textContent).toBe(
      "Add item",
    );
  });

  it("cannot be pressed where nothing runs its actions", async () => {
    const card = await render(list);

    expect(
      [...card.querySelectorAll("button")].every((button) => button.disabled),
    ).toBe(true);
  });
});
