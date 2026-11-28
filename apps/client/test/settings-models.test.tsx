// @vitest-environment jsdom
import type { AppInfo } from "@meetsanctum/app-sdk";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { mac } from "./settings-models-fixtures";
import {
  button,
  click,
  enterText,
  labelled,
  ollamaApp,
  openApp,
  page,
  place,
  selectMenuItem,
  show,
  usageOf,
} from "./settings-models-support";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

describe("Settings → AI models", () => {
  it("shows the source in use first, the others with Use, and their tokens", async () => {
    await show();
    const text = page.container.textContent ?? "";
    expect(text).toContain("Qwen3 8B on Office Mac");
    expect(text).toContain("Ollama at 192.168.1.40:11434");
    expect(text).not.toContain("in your home");
    expect(text).toContain("Other Sources");
    expect(text).toContain("Key ending in 4f2a");
    expect(text).not.toContain("leaves your home");
    expect(text).toContain("Tokens Used4,500 tokens in the last 30 days");
    expect(text).not.toContain("sk-");

    await click(button("Use"));
    expect(page.requests).toContainEqual([
      "POST",
      "/api/models/sources/router/use",
      undefined,
    ]);
    expect(page.container.textContent).toContain("Qwen3 8B on Office Mac");
    expect(button("Use")).toBeDefined();
  });

  it("shows the tokens of the last 30 days by model, or by app", async () => {
    page.apps = [
      {
        id: "sanctum.example",
        name: "Example",
        tokens: { today: 0, month: 0 },
      },
    ];
    page.installed = [{ ...ollamaApp, id: "sanctum.former", name: "Former" }];
    page.usage = usageOf(
      { mac: 100, router: 50 },
      {
        "sanctum.example": 100,
        "sanctum.former": 50,
        "sanctum.third": 20,
        "sanctum.fourth": 10,
      },
    );
    await show();
    const sums = () =>
      [
        ...page.container.querySelectorAll(
          '[aria-labelledby="settings-models-tokens"] ul:not(.sr-only) > li',
        ),
      ].map((each) => each.textContent);

    expect(sums()).toEqual([
      "Qwen3 8B on Office Mac3,000",
      "OpenAI: GPT-5 Mini with OpenRouter1,500",
    ]);
    expect(
      page.container
        .querySelector('[aria-label^="Tokens used"]')
        ?.getAttribute("aria-label"),
    ).toContain("by model");

    await click(
      [...page.container.querySelectorAll("button")].find(
        (each) => each.textContent === "Apps",
      )!,
    );
    expect(sums()).toEqual(["Example3,000", "Former1,500", "Other apps900"]);
  });

  it("keeps the totals and source choices that an older core supports", async () => {
    page.usage = undefined;
    await show();
    expect(page.container.textContent).toContain(
      "Today 46 · last 30 days 1,046",
    );
    expect(
      page.container.querySelector('[aria-label^="Tokens used"]'),
    ).toBeNull();

    await click(button("Add a source"));
    expect(document.querySelectorAll('input[name="where"]')).toHaveLength(2);
    await click(button("Continue"));
    expect(labelled("Address")).toBeDefined();
  });

  it("keeps the usage chart visible when a day is invalid", async () => {
    page.usage!.days[0] = "invalid";
    await show();
    const chart = page.container.querySelector('[aria-label^="Tokens used"]');
    expect(chart?.parentElement?.textContent).toContain("Invalid Date");
  });

  it("reads one day's tokens with the arrow keys", async () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    page.usage!.sources[0]!.tokens[28] = 175;
    await show();
    const chart = page.container.querySelector<HTMLElement>(
      '[aria-label^="Tokens used"]',
    )!;
    const status = () =>
      chart.parentElement!.querySelector('[role="status"]')?.textContent;
    const key = (name: string) =>
      act(async () => {
        chart.dispatchEvent(
          new KeyboardEvent("keydown", { key: name, bubbles: true }),
        );
      });
    await act(async () => chart.focus());
    expect(status()).toBe(
      "Today: Qwen3 8B on Office Mac 100, OpenAI: GPT-5 Mini with OpenRouter 50",
    );
    await key("ArrowLeft");
    const previousDay = "22 Nov";
    expect(status()).toBe(
      `${previousDay}: Qwen3 8B on Office Mac 175, OpenAI: GPT-5 Mini with OpenRouter 50`,
    );
    expect(chart.textContent).toContain(
      `${previousDay}Qwen3 8B on Office Mac175`,
    );
    await key("Escape");
    expect(status()).toBe("");
  });

  it("reads the nearest plotted day on hover and keeps a tapped day pinned", async () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(270);
    page.usage!.sources[0]!.tokens[3] = 125;
    page.usage!.sources[0]!.tokens[4] = 175;
    await show();
    const chart = page.container.querySelector<HTMLElement>(
      '[aria-label^="Tokens used"]',
    )!;
    expect(chart.style.width).toBe("230px");
    chart.getBoundingClientRect = () => new DOMRect(40, 0, 230, 128);
    const readout = () =>
      chart.querySelector(".pointer-events-none")?.textContent;
    const move = (x: number) =>
      chart.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerType: "mouse",
          clientX: 40 + x,
        }),
      );
    const leave = () =>
      chart.dispatchEvent(
        new PointerEvent("pointerout", {
          bubbles: true,
          pointerType: "mouse",
          relatedTarget: document.body,
        }),
      );

    // At x = 28 the point at 24.5 px is closer than the one at 32.5 px.
    await act(async () => move(28));
    expect(readout()).toContain("Qwen3 8B on Office Mac125");
    expect(chart.hasAttribute("data-pinned")).toBe(false);
    await act(async () => leave());
    expect(readout()).toBeUndefined();

    await act(async () => {
      const press = {
        bubbles: true,
        clientX: 73,
        pointerType: "touch",
        pointerId: 1,
        isPrimary: true,
      };
      chart.dispatchEvent(new PointerEvent("pointerdown", press));
      chart.dispatchEvent(new PointerEvent("pointerup", press));
      chart.dispatchEvent(new MouseEvent("click", { ...press, detail: 1 }));
    });
    expect(chart.hasAttribute("data-pinned")).toBe(true);
    expect(readout()).toContain("Qwen3 8B on Office Mac175");
    await act(async () => move(28));
    expect(readout()).toContain("Qwen3 8B on Office Mac125");
    await act(async () => leave());
    expect(readout()).toContain("Qwen3 8B on Office Mac175");
  });

  it("lists the apps that may use it, each opening its page", async () => {
    page.apps = [
      {
        id: "sanctum.example",
        name: "Example",
        tokens: { today: 0, month: 0 },
      },
    ];
    page.installed = [
      { ...ollamaApp, id: "sanctum.example", name: "Example" } as AppInfo,
    ];
    await show();
    const text = page.container.textContent ?? "";

    expect(text).toContain("Apps That Use It");
    expect(text).toContain("ExampleHasn't asked in the last 30 days");
    await click(button("Open"));
    expect(openApp).toHaveBeenCalledWith("sanctum.example");
  });

  it("says when no app uses it, or nothing has used any tokens", async () => {
    page.usage = usageOf({ mac: 0, router: 0 });
    await show();
    const text = page.container.textContent ?? "";

    expect(text).toContain("No app uses your home's AI model yet.");
    expect(text).toContain("None in the last 30 days.");
    expect(
      page.container.querySelector('[aria-label^="Tokens used"]'),
    ).toBeNull();
    expect(
      [...page.container.querySelectorAll("button")].some(
        (each) => each.textContent === "Apps",
      ),
    ).toBe(false);
  });

  it("offers where the model can run when the home has none", async () => {
    page.sources = [];
    await show();
    const text = page.container.textContent ?? "";
    expect(text).toContain("No AI model yet");
    expect(text).toContain("It's the brain of your home.");
    expect(text).not.toContain("Tokens Used");
    // The places are the way in, so the bar has no Add a source.
    expect(button("Add a source")).toBeUndefined();
    const group = page.container.querySelector('[role="group"]')!;
    expect(
      document.getElementById(group.getAttribute("aria-labelledby")!)
        ?.textContent,
    ).toBe("No AI model yet");
    expect(
      [...group.querySelectorAll("button")].map((each) => each.textContent),
    ).toEqual([
      "On SanctumWith the Ollama app.What you ask stays in your home",
      "On a computer in your homeA Mac or PC that runs Ollama.What you ask stays in your home",
      "With an AI providerOpenRouter, Anthropic or OpenAI, with your own API key.What you ask leaves your home",
    ]);
  });

  it("leaves out On Sanctum where Ollama can't run on it", async () => {
    page.sources = [];
    page.usage = undefined;
    await show();
    expect(
      [...page.container.querySelectorAll('[role="group"] button')].map(
        (each) => each.textContent?.split("With")[0]?.split("A Mac")[0],
      ),
    ).toEqual(["On a computer in your home", ""]);
  });

  it("focuses the first source choice after removing the last source", async () => {
    page.sources = [mac];
    await show();
    await selectMenuItem("Remove");
    await click(button("Remove"));
    expect(page.requests).toContainEqual([
      "DELETE",
      "/api/models/sources/mac",
      undefined,
    ]);
    const firstChoice = place("On Sanctum");
    expect(firstChoice).toBeDefined();
    await vi.waitFor(() => expect(document.activeElement).toBe(firstChoice));
  });

  it("keeps a typed computer name until it is saved", async () => {
    await show();
    await selectMenuItem("Rename computer");
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Computer"]',
    )!;
    await enterText(input, "Studio Mac");
    expect(input.value).toBe("Studio Mac");
    await click(button("Save"));
    expect(page.requests).toContainEqual([
      "PATCH",
      "/api/models/sources/mac",
      { computer: "Studio Mac" },
    ]);
  });
});
