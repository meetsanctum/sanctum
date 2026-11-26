// @vitest-environment jsdom
import type { ModelChoice, ModelSourceInfo } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Dialog, DialogContent } from "../src/components/ui/dialog";
import { coreJson } from "../src/core-fetch";
import { ModelPicker } from "../src/models/model-picker";
import { SourceCheck } from "../src/models/source-check";
import { mac, router } from "./settings-models-fixtures";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView ??= () => {};
  vi.mocked(coreJson).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const text = () => document.body.textContent ?? "";
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  )!;
const click = (element: HTMLElement) =>
  act(async () => {
    element.click();
  });
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const added: ModelSourceInfo = {
  ...router,
  id: "added",
  inUse: false,
  checking: false,
  check: {
    at: "2026-11-23T12:00:00Z",
    outcome: "answered",
    firstWordMs: 1200,
    tokens: 312,
  },
};

async function showCheck(
  source: ModelSourceInfo,
  inUse: ModelSourceInfo | undefined = mac,
) {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  await act(async () =>
    root.render(
      <Dialog open>
        <DialogContent>
          <SourceCheck
            source={source}
            inUse={inUse}
            done="Added to your sources"
            onClose={onClose}
            onChanged={onChanged}
          />
        </DialogContent>
      </Dialog>,
    ),
  );
  return { onClose, onChanged };
}

describe("A source's check in the dialog", () => {
  it("says what it's doing while the check runs, and that closing is fine", async () => {
    const { onClose } = await showCheck({ ...added, checking: true });
    expect(text()).toContain("Checking OpenAI: GPT-5 Mini");
    expect(text()).toContain("Added to your sources");
    expect(text()).toContain("Asking it one short question");
    expect(text()).toContain("This takes a few seconds.");
    await click(button("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("says a model in the home can take a minute to load", async () => {
    await showCheck({ ...mac, inUse: false, checking: true }, undefined);
    expect(text()).toContain("This can take a minute while the model loads.");
  });

  it("is ready as the home's AI model once it used the tool", async () => {
    await showCheck({ ...added, inUse: true }, undefined);
    expect(text()).toContain("OpenAI: GPT-5 Mini is ready");
    expect(text()).toContain("It's now your home's AI model.");
    expect(text()).toContain(
      "It answered in 1.2 s and used your home's tools.",
    );
    expect(text()).toContain("The check used 312 tokens");
    expect(button("Use it now")).toBeUndefined();
  });

  it("names the source still in use, and switches with Use it now", async () => {
    vi.mocked(coreJson).mockResolvedValue({ sources: [], apps: [] });
    const { onChanged } = await showCheck(added);
    expect(text()).toContain("Your home still uses Qwen3 8B on Office Mac.");
    await click(button("Use it now"));
    expect(coreJson).toHaveBeenCalledWith(
      "/api/models/sources/added/use",
      expect.objectContaining({ method: "POST" }),
    );
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("says why it didn't answer, and checks again", async () => {
    vi.mocked(coreJson).mockResolvedValue({ sources: [], apps: [] });
    await showCheck({
      ...added,
      check: {
        at: "2026-11-23T12:00:00Z",
        outcome: "failed",
        problem: "timeout",
        tokens: 0,
      },
    });
    expect(text()).toContain("OpenAI: GPT-5 Mini didn't answer");
    expect(text()).toContain("OpenRouter took too long to answer.");
    expect(text()).toContain("The check used no tokens");
    await click(button("Check again"));
    expect(coreJson).toHaveBeenCalledWith(
      "/api/models/sources/added/check",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("leaves out what a check used before checks kept it", async () => {
    await showCheck({
      ...added,
      check: { ...added.check!, tokens: undefined },
    });
    expect(text()).toContain("is ready");
    expect(text()).not.toContain("The check used");
  });

  it("offers another model when it answered without the tool", async () => {
    vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
      if (path === "/api/models/sources/added/models") {
        return {
          found: true,
          models: [
            { id: router.model, name: router.modelName },
            {
              id: "anthropic/claude-sonnet-5.5",
              name: "Anthropic: Claude Sonnet 5.5",
            },
          ],
        } as never;
      }
      if (init.method === "PATCH") return { sources: [], apps: [] } as never;
      throw new Error(`Unexpected request: ${path}`);
    });
    const { onChanged } = await showCheck({
      ...added,
      check: { ...added.check!, outcome: "noTool" },
    });
    expect(text()).toContain("OpenAI: GPT-5 Mini may not work well");
    await click(button("Choose another model"));
    expect(text()).toContain(
      "Checking it uses tokens again, and OpenRouter charges for them.",
    );
    expect(button("Change and check").disabled).toBe(true);
    await click(
      document.querySelector<HTMLButtonElement>('button[role="combobox"]')!,
    );
    // The model in use isn't offered again.
    const items = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")];
    expect(items.map((item) => item.textContent)).toEqual([
      "Claude Sonnet 5.5",
    ]);
    await click(items[0]!);
    await click(button("Change and check"));
    expect(coreJson).toHaveBeenCalledWith(
      "/api/models/sources/added",
      expect.objectContaining({
        method: "PATCH",
        json: { model: "anthropic/claude-sonnet-5.5" },
      }),
    );
    expect(onChanged).toHaveBeenCalledOnce();
  });
});

describe("Choosing a model", () => {
  const models: ModelChoice[] = [
    { id: "anthropic/claude-sonnet-5.5", name: "Anthropic: Claude Sonnet 5.5" },
    { id: "openai/gpt-5-mini", name: "OpenAI: GPT-5 Mini" },
    { id: "anthropic/claude-haiku-5.5", name: "Anthropic: Claude Haiku 5.5" },
    { id: "openrouter/auto", name: "Auto Router" },
  ];

  async function showPicker(value = "", list = models) {
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <ModelPicker
          aria-label="Model"
          models={list}
          value={value}
          onChange={onChange}
        />,
      ),
    );
    return onChange;
  }
  const trigger = () =>
    document.querySelector<HTMLButtonElement>('button[role="combobox"]')!;
  const search = () =>
    document.querySelector<HTMLInputElement>(
      'input[aria-label="Search models"]',
    )!;
  const headings = () =>
    [...document.querySelectorAll("[cmdk-group-heading]")].map(
      (heading) => heading.textContent,
    );
  const rows = () =>
    [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].map(
      (item) => item.textContent,
    );

  it("chooses none for the household, and shows the one chosen with its maker", async () => {
    await showPicker();
    expect(trigger().textContent).toBe("Choose a model");
    await act(async () =>
      root.render(
        <ModelPicker
          aria-label="Model"
          models={models}
          value="anthropic/claude-sonnet-5.5"
          onChange={() => {}}
        />,
      ),
    );
    expect(trigger().textContent).toBe("Claude Sonnet 5.5 · Anthropic");
  });

  it("groups a provider's models by maker, each by its own name", async () => {
    await showPicker();
    await click(trigger());
    expect(search().placeholder).toBe("Search 4 models");
    expect(headings()).toEqual(["Anthropic", "OpenAI"]);
    expect(rows()).toEqual([
      "Claude Sonnet 5.5",
      "Claude Haiku 5.5",
      "GPT-5 Mini",
      "Auto Router",
    ]);
  });

  it("filters as you type, counts what it hides and says when nothing matches", async () => {
    const onChange = await showPicker();
    await click(trigger());
    await type(search(), "SONNET");
    expect(rows()).toEqual(["Claude Sonnet 5.5"]);
    expect(text()).toContain("1 of 4 models");
    await type(search(), "openai");
    expect(rows()).toEqual(["GPT-5 Mini"]);
    await type(search(), "clade");
    expect(rows()).toEqual([]);
    expect(text()).toContain("No models match “clade”.");
    expect(text()).toContain("Check the spelling, or search for the maker.");
    await type(search(), "haiku");
    await click(document.querySelector<HTMLElement>("[cmdk-item]")!);
    expect(onChange).toHaveBeenCalledWith("anthropic/claude-haiku-5.5");
  });

  it("shows a computer's models with their size", async () => {
    await showPicker("", [
      { id: "qwen3:8b", name: "Qwen3 8B", size: 5_200_000_000 },
    ]);
    await click(trigger());
    expect(headings()).toEqual([]);
    expect(rows()).toEqual(["Qwen3 8B5.2 GB"]);
  });
});
