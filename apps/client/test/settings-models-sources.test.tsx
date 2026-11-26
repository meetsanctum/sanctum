// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { mac, now, router } from "./settings-models-fixtures";
import {
  anthropic,
  button,
  chooseModel,
  click,
  enterText,
  labelled,
  live,
  ollamaApp,
  openApp,
  page,
  place,
  selectMenuItem,
  show,
} from "./settings-models-support";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const dialog = () => document.querySelector('[role="dialog"]');

async function finishCheck(id: string, tokens: number) {
  page.sources = page.sources.map((source) =>
    source.id === id
      ? {
          ...source,
          checking: false,
          check: {
            at: now.toISOString(),
            outcome: "answered",
            firstWordMs: 1200,
            tokens,
          },
        }
      : source,
  );
  await act(async () => live.refresh());
}

describe("AI model source dialogs", () => {
  it("starts Add a source at the place chosen, and gives focus back to it", async () => {
    page.sources = [];
    await show();
    const modelSelect = () =>
      document.querySelector<HTMLButtonElement>(
        '[role="dialog"] button[data-slot="popover-trigger"]',
      ) ?? undefined;
    const provider = place("With an AI provider");
    await click(provider);
    expect(document.querySelector('input[name="where"]')).toBeNull();
    expect(document.body.textContent).toContain("Adding it runs a check");
    await click(button("Back"));
    const selected = document.querySelector<HTMLInputElement>(
      'input[name="where"]:checked',
    );
    expect(selected?.labels?.[0]?.textContent).toMatch(/^With an AI provider/);
    await click(button("Continue"));
    expect(document.body.textContent).toContain("Adding it runs a check");
    await enterText(labelled("API key"), "sk-or-v1-test-key-4f2a");
    await click(button("Check key"));
    expect(document.body.textContent).toContain("The key works");
    expect(modelSelect()).toBeDefined();

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(document.querySelector("[role=dialog]")).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(provider));

    await click(place("On a computer in your home"));
    expect(labelled("Address")).toBeDefined();
    expect(modelSelect()).toBeUndefined();
    expect(button("Add and check").disabled).toBe(true);
  });

  it("focuses the first available choice if the last source disappears while adding", async () => {
    page.sources = [mac];
    page.usage = undefined;
    await show();
    await click(button("Add a source"));
    page.sources = [];
    await act(async () => live.refresh());
    await click(button("Cancel"));
    const firstChoice = place("On a computer in your home");
    expect(firstChoice).toBeDefined();
    await vi.waitFor(() => expect(document.activeElement).toBe(firstChoice));
  });

  it("can change to the sole available model when the saved model is gone", async () => {
    await show();
    await selectMenuItem("Change model");
    // The saved model is gone, and none is chosen for the household.
    expect(button("Save").disabled).toBe(true);
    await chooseModel("Llama3.2 3B");
    await click(button("Save"));
    expect(page.requests).toContainEqual([
      "PATCH",
      "/api/models/sources/mac",
      { model: "llama3.2:3b" },
    ]);
    expect(dialog()?.textContent).toContain("Checking Llama3.2 3B");
    expect(dialog()?.textContent).toContain("Model changed");
    await finishCheck("mac", 147);
    expect(dialog()?.textContent).toContain("Llama3.2 3B is ready");
    expect(dialog()?.textContent).toContain("The check used 147 tokens");
  });

  it("replaces the key for a saved Anthropic source", async () => {
    page.sources.push(anthropic);
    await show();
    await selectMenuItem("Replace key", anthropic);
    await enterText(
      document.querySelector<HTMLInputElement>('input[aria-label="API key"]')!,
      "sk-ant-api03-new-test-key",
    );
    await click(button("Save"));

    expect(page.requests).toContainEqual([
      "PATCH",
      "/api/models/sources/anthropic",
      { key: "sk-ant-api03-new-test-key" },
    ]);
    // The new key is checked, and the dialog follows the check.
    expect(dialog()?.textContent).toContain("Checking Claude Sonnet 5.5");
    expect(dialog()?.textContent).toContain("Key replaced");
    await finishCheck(anthropic.id, 213);
    expect(dialog()?.textContent).toContain("Claude Sonnet 5.5 is ready");
    expect(dialog()?.textContent).toContain("The check used 213 tokens");
    await click(button("Done"));
    expect(dialog()).toBeNull();
  });

  it("adds a computer once Sanctum has found Ollama there", async () => {
    await show();
    await click(button("Add a source"));
    await click(
      [...document.querySelectorAll("input[type=radio]")].at(
        1,
      ) as HTMLInputElement,
    );
    await click(button("Continue"));
    expect(button("Add and check").disabled).toBe(true);

    await enterText(labelled("Address"), "192.168.1.9");
    await click(button("Check"));
    expect(document.body.textContent).toContain(
      "Nothing answered at 192.168.1.9:11434",
    );

    await enterText(labelled("Address"), "studio.local");
    await click(button("Check"));
    expect(document.body.textContent).toContain(
      "Found Ollama at 192.168.1.50:11434, with 1 model",
    );
    await enterText(labelled("Computer"), "Studio Mac");
    expect(button("Add and check").disabled).toBe(true);
    await chooseModel("Llama3.2 3B");
    page.sources = [...page.sources, { ...router, id: "other-client" }];
    await click(button("Add and check"));
    expect(page.requests).toContainEqual([
      "POST",
      "/api/models/sources",
      {
        kind: "computer",
        address: "192.168.1.50:11434",
        computer: "Studio Mac",
        model: "llama3.2:3b",
      },
    ]);
    // The dialog stays on the new source's check until it ends.
    expect(dialog()?.textContent).toContain("Checking Llama3.2 3B");
    expect(dialog()?.textContent).toContain("Added to your sources");
    await finishCheck("studio", 312);
    expect(dialog()?.textContent).toContain("Llama3.2 3B is ready");
    expect(dialog()?.textContent).toContain(
      "Your home still uses Qwen3 8B on Office Mac.",
    );
    expect(dialog()?.textContent).toContain("The check used 312 tokens");
    expect(button("Use it now")).toBeDefined();
    await click(button("Done"));
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("closes after saving when an older core returns two unfamiliar sources", async () => {
    page.includeAddedSourceId = false;
    await show();
    await click(button("Add a source"));
    await click(
      document.querySelectorAll<HTMLInputElement>('input[name="where"]')[1]!,
    );
    await click(button("Continue"));
    await enterText(labelled("Address"), "studio.local");
    await click(button("Check"));
    await enterText(labelled("Computer"), "Studio Mac");
    await chooseModel("Llama3.2 3B");
    page.sources = [...page.sources, { ...router, id: "other-client" }];
    await click(button("Add and check"));
    expect(dialog()).toBeNull();
    expect(page.container.textContent).toContain("Llama3.2 3B on Studio Mac");
  });

  it("requires another selection when rechecking removes the selected model", async () => {
    await show();
    await click(button("Add a source"));
    await click(
      document.querySelectorAll<HTMLInputElement>('input[name="where"]')[1]!,
    );
    await click(button("Continue"));
    await enterText(labelled("Address"), "studio.local");
    await click(button("Check"));
    await enterText(labelled("Computer"), "Studio Mac");
    await chooseModel("Llama3.2 3B");
    expect(button("Add and check").disabled).toBe(false);
    page.offeredModels = [{ id: mac.model, name: mac.modelName }];
    await click(button("Check"));
    expect(dialog()?.textContent).toContain("Choose a model");
    expect(button("Add and check").disabled).toBe(true);
    await chooseModel(mac.modelName);
    expect(button("Add and check").disabled).toBe(false);
  });

  it("adds a provider once its key works", async () => {
    await show();
    await click(button("Add a source"));
    const provider = [...document.querySelectorAll("input[type=radio]")].at(
      2,
    ) as HTMLInputElement;
    await click(provider);
    await click(button("Continue"));
    expect(document.body.textContent).toContain("Adding it runs a check");
    await enterText(labelled("API key"), "sk-or-v1-test-key-4f2a");
    await click(button("Check key"));
    expect(document.body.textContent).toContain(
      "The key works. It can use 1 model.",
    );
    await chooseModel("Llama3.2 3B");
    await click(button("Add and check"));
    expect(page.requests).toContainEqual([
      "POST",
      "/api/models/sources",
      {
        kind: "openrouter",
        key: "sk-or-v1-test-key-4f2a",
        model: "llama3.2:3b",
      },
    ]);
  });

  it("checks only the key entered for the selected provider", async () => {
    await show();
    await click(button("Add a source"));
    await click(
      document.querySelectorAll<HTMLInputElement>('input[name="where"]')[2]!,
    );
    await click(button("Continue"));
    const key = labelled("API key");
    await enterText(key, "sk-or-v1-test-key-4f2a");
    expect(document.body.textContent).not.toContain("keeps the start");
    await click(button("Anthropic"));
    expect(document.body.textContent).toContain(
      "Anthropic keeps the start of a conversation for a few minutes to answer faster.",
    );
    expect(key.value).toBe("");
    expect(button("Check key").disabled).toBe(true);
    expect(
      page.requests.filter(([, path]) => path === "/api/models/look"),
    ).toEqual([]);

    await enterText(key, "sk-ant-api03-test-key-7c1d");
    await click(button("Check key"));
    expect(page.requests).toContainEqual([
      "POST",
      "/api/models/look",
      { kind: "anthropic", key: "sk-ant-api03-test-key-7c1d" },
    ]);
  });

  it("adds Ollama on Sanctum, then points to its page for a model", async () => {
    // Ollama doesn't answer yet while its image downloads.
    page.isOllamaAvailable = false;
    await show();
    await click(button("Add a source"));
    await click(button("Continue"));

    expect(document.body.textContent).toContain(
      "Add the Ollama app, then download a model on its page.",
    );
    expect(document.body.textContent).toContain("Use Ollama");
    await click(button("Add Ollama"));
    expect(page.requests).toContainEqual([
      "POST",
      "/api/apps/add",
      { id: "sanctum.ollama", version: "0.1.0" },
    ]);
    expect(document.body.textContent).toContain("Ollama is added to Sanctum");
    expect(document.body.textContent).toContain(
      "Go to the Ollama app to download a model.",
    );
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(
      page.requests.filter(([, path]) => path === "/api/models/look"),
    ).toEqual([]);

    await click(button("Open Ollama"));
    expect(openApp).toHaveBeenCalledWith("sanctum.ollama");
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("reports an unreachable Ollama without saying it needs a model", async () => {
    page.installed = [ollamaApp];
    page.isOllamaAvailable = false;
    await show();
    await click(button("Add a source"));
    await click(button("Continue"));

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Ollama isn't answering.",
    );
    expect(document.body.textContent).not.toContain(
      "Go to the Ollama app to download a model.",
    );
    expect(button("Open Ollama")).toBeDefined();
  });

  it("focuses Add a source after saving the first model on Sanctum", async () => {
    page.sources = [];
    page.includeAddedSourceId = false;
    page.installed = [ollamaApp];
    page.sanctumModels = [
      { id: "qwen3:4b", name: "Qwen3 4B", size: 2_500_000_000 },
      { id: "qwen3:1.7b", name: "Qwen3 1.7B", size: 1_400_000_000 },
    ];
    await show();
    const opener = place("On Sanctum");
    await click(opener);

    expect(document.body.textContent).toContain("Choose a model.");
    expect(document.body.textContent).toContain("qwen3:4b · 2.5 GB");
    await click(labelled("Qwen3 1.7Bqwen3:1.7b · 1.4 GB"));
    await click(button("Add and check"));
    expect(page.requests).toContainEqual([
      "POST",
      "/api/models/sources",
      { kind: "sanctum", model: "qwen3:1.7b" },
    ]);
    await click(button("Close"));
    expect(opener.isConnected).toBe(false);
    const addSource = button("Add a source");
    expect(addSource).toBeDefined();
    await vi.waitFor(() => expect(document.activeElement).toBe(addSource));
  });
});
