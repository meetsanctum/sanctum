// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { FieldProblem, Problem } from "../src/problem";

// A problem says what happened, then why and what to do, behind a sign a
// screen reader skips, on the card's fill, its words selectable.

it("says what happened, then what to do, as one alert", () => {
  const markup = renderToStaticMarkup(
    <Problem title="Light 25 didn't blink" className="basis-full">
      Check that it has power, then try again.
    </Problem>,
  );
  const holder = document.createElement("div");
  holder.innerHTML = markup;
  const alert = holder.firstElementChild!;

  expect(alert.getAttribute("role")).toBe("alert");
  expect(
    [
      ...alert.querySelectorAll(
        "[data-slot=alert-title], [data-slot=alert-description]",
      ),
    ].map((p) => p.textContent),
  ).toEqual([
    "Light 25 didn't blink",
    "Check that it has power, then try again.",
  ]);
  expect(alert.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(alert.classList).toContain("*:[svg]:text-destructive");
  expect(alert.classList).toContain("bg-card");
  expect(alert.classList).toContain("select-text");
  expect(alert.classList).toContain("basis-full");
});

it("can say what happened alone", () => {
  const markup = renderToStaticMarkup(
    <Problem title="Light 2 wasn't removed" />,
  );
  expect(markup).toContain('data-slot="alert-title"');
  expect(markup).not.toContain('data-slot="alert-description"');
});

it("says what to change in a field, with a red sign and words that can wrap", () => {
  const markup = renderToStaticMarkup(
    <FieldProblem id="days-problem">Use a number from 1 to 14.</FieldProblem>,
  );
  const holder = document.createElement("div");
  holder.innerHTML = markup;
  const line = holder.firstElementChild!;

  expect(line.getAttribute("role")).toBe("alert");
  expect(line.getAttribute("data-slot")).toBe("field-error");
  expect(line.id).toBe("days-problem");
  expect(line.textContent).toBe("Use a number from 1 to 14.");
  expect(line.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(line.classList).toContain("text-destructive");
  expect(line.querySelector("span")?.classList).toContain("wrap-anywhere");
  expect(line.querySelector("[data-slot]")).toBeNull();
});
