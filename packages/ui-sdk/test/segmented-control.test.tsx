// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SegmentedControl } from "../src/kit";

// A segmented control: a few choices side by side, one chosen at a time,
// heard as radio buttons, named by its label, and pressing the chosen one
// keeps it.

let container: HTMLDivElement;
let root: Root;

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

const options = [
  { value: "automatic", label: "Automatic" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
] as const;

async function render(
  value: "automatic" | "on" | "off" | undefined,
  onValueChange = vi.fn(),
  extra: { fill?: boolean } = {},
) {
  await act(async () => {
    root.render(
      <SegmentedControl
        label="Reduce effects"
        options={options}
        value={value}
        onValueChange={onValueChange}
        {...extra}
      />,
    );
  });
  const group = container.querySelector<HTMLElement>('[role="radiogroup"]')!;
  const segments = [...container.querySelectorAll<HTMLButtonElement>("button")];
  return { group, segments, onValueChange };
}

it("is named by its label and says which segment is chosen", async () => {
  const { group, segments } = await render("on");
  expect(group.getAttribute("role")).toBe("radiogroup");
  expect(group.getAttribute("aria-label")).toBe("Reduce effects");
  expect(segments.map((segment) => segment.textContent)).toEqual([
    "Automatic",
    "On",
    "Off",
  ]);
  expect(segments.map((segment) => segment.getAttribute("role"))).toEqual([
    "radio",
    "radio",
    "radio",
  ]);
  expect(
    segments.map((segment) => segment.getAttribute("aria-checked")),
  ).toEqual(["false", "true", "false"]);
});

it("chooses another segment, and keeps the chosen one when pressed again", async () => {
  const { segments, onValueChange } = await render("automatic");
  await act(async () => segments[2]!.click());
  expect(onValueChange).toHaveBeenCalledWith("off");
  onValueChange.mockClear();
  await act(async () => segments[0]!.click());
  expect(onValueChange).not.toHaveBeenCalled();
});

it("chooses none while the value isn't known", async () => {
  const { segments } = await render(undefined);
  expect(
    segments.every(
      (segment) => segment.getAttribute("aria-checked") === "false",
    ),
  ).toBe(true);
});

it.each([
  ["ArrowRight", 2],
  ["ArrowDown", 2],
  ["ArrowLeft", 0],
  ["ArrowUp", 0],
] as const)("selects the segment reached with %s", async (key, index) => {
  const { segments, onValueChange } = await render("on");
  await act(async () => segments[1]!.focus());
  await act(async () => {
    segments[1]!.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keyup", { key, bubbles: true }),
    );
  });
  expect(document.activeElement).toBe(segments[index]);
  expect(onValueChange).toHaveBeenCalledExactlyOnceWith(options[index].value);
});

it("can select an empty string as a choice distinct from no selection", async () => {
  const onValueChange = vi.fn();
  const renderWithValue = (value: string | undefined) =>
    act(async () => {
      root.render(
        <SegmentedControl
          label="Preference"
          options={[
            { value: "", label: "Default" },
            { value: "custom", label: "Custom" },
          ]}
          value={value}
          onValueChange={onValueChange}
        />,
      );
    });
  await renderWithValue(undefined);
  const first = container.querySelector<HTMLButtonElement>('[role="radio"]')!;
  expect(first.getAttribute("aria-checked")).toBe("false");

  await act(async () => first.click());
  expect(onValueChange).toHaveBeenCalledExactlyOnceWith("");

  await renderWithValue("");
  expect(first.getAttribute("aria-checked")).toBe("true");
});

it("gives every segment the same width, and stretches only when asked", async () => {
  let { group } = await render("on");
  expect(group.classList.contains("auto-cols-fr")).toBe(true);
  expect(group.classList.contains("w-full")).toBe(false);
  ({ group } = await render("on", vi.fn(), { fill: true }));
  expect(group.classList.contains("auto-cols-fr")).toBe(true);
  expect(group.classList.contains("w-full")).toBe(true);
});

it("is a menu of the same choices on a phone, with phoneMenu", async () => {
  const onValueChange = vi.fn();
  await act(async () => {
    root.render(
      <SegmentedControl
        label="Show"
        options={options}
        value="on"
        onValueChange={onValueChange}
        phoneMenu
      />,
    );
  });
  const group = container.querySelector<HTMLElement>('[role="radiogroup"]')!;
  const menu = container.querySelector("select")!;
  expect(group.classList.contains("max-sm:hidden")).toBe(true);
  expect(menu.parentElement!.classList.contains("sm:hidden")).toBe(true);
  expect(menu.getAttribute("aria-label")).toBe("Show");
  expect([...menu.options].map((option) => option.text)).toEqual([
    "Automatic",
    "On",
    "Off",
  ]);
  expect(menu.selectedOptions[0]!.text).toBe("On");

  await act(async () => {
    menu.value = menu.options[2]!.value;
    menu.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onValueChange).toHaveBeenCalledExactlyOnceWith("off");
});

it("has no menu without phoneMenu", async () => {
  await render("on");
  expect(container.querySelector("select")).toBeNull();
});
