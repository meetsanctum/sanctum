// @vitest-environment jsdom
import { Sun } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { SectionButton } from "../src/kit";

// A section button is a chip in a line, such as a room's lights button: a
// plain button that submits nothing, its 18 px icon and its name, the name on
// hover too, White without being pressed while lit, and pressed while active.

const render = (element: React.ReactElement) => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(element);
  return container.querySelector("button")!;
};
const control = { icon: Sun, name: "Preview", onClick: () => undefined };

it("is lit with its name on hover, even while disabled", () => {
  const button = render(
    <SectionButton {...control} lit disabled label="Preview in Office" />,
  );
  expect(button.type).toBe("button");
  expect(button.disabled).toBe(true);
  expect(button.title).toBe("Preview in Office");
  expect(button.getAttribute("aria-label")).toBe("Preview in Office");
  expect(button.hasAttribute("data-on")).toBe(true);
  expect(button.hasAttribute("aria-pressed")).toBe(false);
  expect(button.querySelector("svg")?.classList.contains("size-[18px]")).toBe(
    true,
  );
  expect(button.querySelector(".pointer-events-auto")?.textContent).toBe(
    "Preview",
  );
});

it("says it is pressed while active, and its own name without a label", () => {
  const button = render(<SectionButton {...control} active />);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.hasAttribute("data-on")).toBe(false);
  expect(button.title).toBe("Preview");
});
