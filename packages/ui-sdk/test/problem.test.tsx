// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { Problem } from "../src/problem";

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
  expect([...alert.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
    "Light 25 didn't blink",
    "Check that it has power, then try again.",
  ]);
  expect(alert.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(alert.querySelector("svg")?.classList).toContain("text-destructive");
  expect(alert.classList).toContain("bg-card");
  expect(alert.classList).toContain("select-text");
  expect(alert.classList).toContain("basis-full");
});

it("can say what happened alone", () => {
  const markup = renderToStaticMarkup(
    <Problem title="Light 2 wasn't removed" />,
  );
  expect(markup.match(/<p /g)).toHaveLength(1);
});
