// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { FieldControl } from "../src/automations/fields";
import { places } from "./automations-fixtures";

// The place picker offers the whole home, then its floors in their order,
// then its rooms, and shows a workflow's chosen floor as chosen.

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

it("offers floors in the place picker and keeps the chosen floor selected", async () => {
  const onChange = vi.fn();
  const context = {
    home: { places, devices: [], entities: [] },
    config: {},
  };
  const show = async (value: unknown) => {
    await act(async () => {
      root.render(
        <FieldControl
          name="place"
          field={{ place: true }}
          value={value}
          context={context}
          onChange={onChange}
        />,
      );
    });
  };

  await show({ kind: "room", id: "office" });
  // From the widest place to the narrowest.
  expect(
    [...container.querySelectorAll('[role="option"]')].map(
      (option) => option.textContent,
    ),
  ).toEqual(["The whole home", "Ground floor", "Office", "Living room"]);
  const floor = [
    ...container.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((option) => option.textContent === "Ground floor");
  expect(floor).toBeDefined();
  await act(async () => floor!.click());
  expect(onChange).toHaveBeenCalledWith({ kind: "floor", id: "ground" });

  await show({ kind: "floor", id: "ground" });
  expect(
    container.querySelector('[role="option"][aria-selected="true"]')
      ?.textContent,
  ).toBe("Ground floor");
});
