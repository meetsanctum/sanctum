// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";

import { container, remountHome } from "./home-shell-harness";
import { problemLines } from "./problem-lines";

const imports = vi.hoisted(() =>
  vi.fn(() => {
    throw new TypeError("Failed to fetch dynamically imported module");
  }),
);
vi.mock("../src/settings", imports);
vi.mock("../src/automations/page", imports);

it("loads system pages ahead of time, keeping Home when that fails", async () => {
  imports.mockClear();
  vi.useFakeTimers();
  try {
    await remountHome();
    expect(imports).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await vi.dynamicImportSettled();
    expect(imports).toHaveBeenCalled();
    // A failure ahead of time is left to the page's opening.
    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(container.querySelector("main")).not.toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it.each(["Settings", "Automations"])(
  "keeps navigation available when %s fails to load",
  async (name) => {
    const apps = container.querySelector<HTMLButtonElement>(
      'aside button[aria-label="Apps"]',
    )!;
    await act(async () => apps.click());
    const systemPage = [
      ...container.querySelectorAll<HTMLButtonElement>("main li button"),
    ].find((button) => button.textContent === name)!;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => systemPage.click());
      await vi.waitFor(() =>
        expect(
          problemLines(container.querySelector("main [role=alert]")),
        ).toEqual([
          `${name} didn't open`,
          "Something went wrong while showing it. Reload to try again.",
        ]),
      );
    } finally {
      log.mockRestore();
    }

    expect(container.querySelector("main button")?.textContent).toBe("Reload");
    await act(async () => apps.click());
    expect(container.querySelector(".top-bar h1")?.textContent).toBe("Apps");
  },
);
