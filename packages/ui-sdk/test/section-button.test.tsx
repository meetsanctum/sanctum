// @vitest-environment jsdom
import { Sun } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { SectionButton, SectionTile } from "../src/kit";

const control = { icon: Sun, name: "Preview", onClick: () => undefined };

it("keeps the inline button's sizing and implicit form submission", () => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <form>
      <SectionButton {...control} active={false} />
    </form>,
  );
  const button = container.querySelector("button")!;
  const submit = vi.fn((event: Event) => event.preventDefault());
  button.form!.addEventListener("submit", submit);

  expect(button.type).toBe("submit");
  expect(button.classList.contains("max-w-full")).toBe(false);
  expect(button.querySelector("svg")?.classList.contains("size-[18px]")).toBe(
    false,
  );
  document.body.append(container);
  try {
    button.click();
    expect(submit).toHaveBeenCalledOnce();
  } finally {
    container.remove();
  }
});

const roomControl = {
  ...control,
  lit: true,
  disabled: true,
  label: "Preview in Office",
};

it.each([
  ["a room button", <SectionButton {...roomControl} layout="room" />],
  ["a tile chip", <SectionTile {...roomControl} chip />],
])("keeps %s lit with a hover label while disabled", (_name, element) => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(element);
  const button = container.querySelector("button")!;
  expect(button.type).toBe("button");
  expect(button.disabled).toBe(true);
  expect(button.title).toBe("Preview in Office");
  expect(button.getAttribute("aria-label")).toBe(button.title);
  expect(button.hasAttribute("data-on")).toBe(true);
  expect(button.hasAttribute("aria-pressed")).toBe(false);
  expect(button.classList.contains("max-w-full")).toBe(true);
  expect(button.querySelector("svg")?.classList.contains("size-[18px]")).toBe(
    true,
  );
  expect(button.querySelector(".pointer-events-auto")?.textContent).toBe(
    "Preview",
  );
});
