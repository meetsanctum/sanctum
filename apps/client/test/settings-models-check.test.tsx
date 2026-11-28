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
import { problemLines } from "./problem-lines";

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
const currentStep = () =>
  document.querySelector('[aria-current="step"]')?.textContent;
function expectCurrentStepSpinner() {
  const spinners = document.querySelectorAll(
    'ol[aria-label="Steps"] .animate-spin',
  );
  expect(spinners).toHaveLength(1);
  const [spinner] = spinners;
  expect(spinner?.closest("li")?.getAttribute("aria-current")).toBe("step");
  expect(spinner?.classList).toContain("motion-reduce:animate-none");
}
const elapse = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));
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
  it.each([
    {
      source: {
        ...mac,
        kind: "sanctum",
        computer: undefined,
        address: undefined,
      },
      icon: "cpu",
    },
    { source: mac, icon: "laptop" },
    { source: router, icon: "cloud" },
  ] as const)(
    "shows only the source icon above the steps for $source.kind",
    async ({ source, icon }) => {
      await showCheck({ ...source, checking: true });

      const headerIcons = document.querySelectorAll(
        '[role="dialog"] [role="status"] svg:not(ol svg)',
      );
      expect(headerIcons).toHaveLength(1);
      expect(headerIcons[0]?.classList).toContain(`lucide-${icon}`);
    },
  );

  it("says what it's doing while the check runs, and that closing is fine", async () => {
    const { onClose } = await showCheck({ ...added, checking: true });
    // The model by its own name, as the model list shows it.
    expect(text()).toContain("Checking GPT-5 Mini");
    expect(text()).toContain("Added to your sources");
    expect(text()).toContain("Asking it one short question");
    expect(text()).toContain("This takes a few seconds.");
    expect(text()).toContain(
      "If you close this, the check carries on. AI Models shows any problems it finds.",
    );
    await click(button("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps each step on screen for two seconds, however fast the answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await showCheck({ ...added, checking: true });
      expect(currentStep()).toBe("Asking it one short question");
      expectCurrentStepSpinner();
      // The answer is in at once: asking still has its two seconds.
      await showCheck(added);
      expect(text()).not.toContain("the check carries on");
      await elapse(1_999);
      expect(currentStep()).toBe("Asking it one short question");
      await elapse(1);
      expect(text()).toContain("Asked it one short question");
      expect(currentStep()).toBe("Seeing whether it uses the tool");
      expectCurrentStepSpinner();
      expect(text()).not.toContain("the check carries on");
      await elapse(1_999);
      expect(currentStep()).toBe("Seeing whether it uses the tool");
      await elapse(1);
      expect(text()).toContain("GPT-5 Mini is ready");

      // A slow answer keeps asking for as long as it takes.
      await showCheck({ ...added, checking: true });
      await elapse(10_000);
      expect(currentStep()).toBe("Asking it one short question");
      await showCheck(added);
      expect(currentStep()).toBe("Seeing whether it uses the tool");
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a new check at asking while the previous tool step is visible", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await showCheck({ ...added, checking: true });
      await showCheck(added);
      await elapse(2_000);
      expect(currentStep()).toBe("Seeing whether it uses the tool");
      await elapse(1_000);

      await showCheck({ ...added, checking: true });
      expect(currentStep()).toBe("Asking it one short question");
      await showCheck(added);
      await elapse(1_999);
      expect(currentStep()).toBe("Asking it one short question");
      await elapse(1);
      expect(currentStep()).toBe("Seeing whether it uses the tool");
      await elapse(1_999);
      expect(currentStep()).toBe("Seeing whether it uses the tool");
      await elapse(1);
      expect(text()).toContain("GPT-5 Mini is ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a check that failed before asking without a tool step", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await showCheck({ ...mac, checking: true });
      await showCheck({
        ...mac,
        check: { at: added.check!.at, outcome: "failed", problem: "model" },
      });
      await elapse(1_999);
      expect(currentStep()).toBe("Asking it one short question");
      await elapse(1);
      expect(currentStep()).toBeUndefined();
      expect(text()).toContain("That model isn't there any more.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says a model in the home can take a minute to load", async () => {
    await showCheck({ ...mac, inUse: false, checking: true }, undefined);
    expect(text()).toContain("This can take a minute while the model loads.");
  });

  it("is ready as the home's AI model once it used the tool", async () => {
    await showCheck({ ...added, inUse: true }, undefined);
    expect(text()).toContain("GPT-5 Mini is ready");
    expect(text()).toContain("It's now your home's AI model.");
    expect(text()).toContain("Answered in 1.2 s · used 312 tokens");
    expect(button("Switch to GPT-5 Mini")).toBeUndefined();
  });

  it("names the source still in use, and switches to this one", async () => {
    vi.mocked(coreJson).mockResolvedValue({ sources: [], apps: [] });
    const { onChanged } = await showCheck(added);
    // Where the other one runs, as it's somewhere else.
    expect(text()).toContain("Your home still uses Qwen3 8B on Office Mac.");
    expect(text()).toContain("Answered in 1.2 s · used 312 tokens");
    // Switching right after its check doesn't check again: nothing to warn of.
    expect(text()).not.toContain("charge");
    await click(button("Switch to GPT-5 Mini"));
    expect(coreJson).toHaveBeenCalledWith(
      "/api/models/sources/added/use",
      expect.objectContaining({ method: "POST" }),
    );
    expect(onChanged).toHaveBeenCalledOnce();
    // Its check says what came before it, not the addition.
    await act(async () =>
      root.render(
        <Dialog open>
          <DialogContent>
            <SourceCheck
              source={{ ...added, inUse: true, checking: true }}
              inUse={undefined}
              done="Added to your sources"
              onClose={() => {}}
              onChanged={() => {}}
            />
          </DialogContent>
        </Dialog>,
      ),
    );
    expect(text()).toContain("Now your home's AI model");
    expect(text()).not.toContain("Added to your sources");
  });

  it("names another model from the same provider by its own name", async () => {
    await showCheck(added, {
      ...router,
      model: "anthropic/claude-haiku-4.5",
      modelName: "Anthropic: Claude Haiku 4.5",
      inUse: true,
    });
    expect(text()).toContain("Your home still uses Claude Haiku 4.5.");
    expect(button("Switch to GPT-5 Mini")).toBeDefined();
  });

  it("keeps the makers when two models from the same provider share their own name", async () => {
    await showCheck(
      { ...added, modelName: "Maker A: Model X" },
      {
        ...router,
        model: "maker-b/model-x",
        modelName: "Maker B: Model X",
        inUse: true,
      },
    );
    expect(text()).toContain("Your home still uses Maker B: Model X.");
    expect(button("Switch to Maker A: Model X")).toBeDefined();
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
    expect(text()).toContain("GPT-5 Mini didn't answer");
    expect(text()).toContain("OpenRouter took too long to answer.");
    expect(text()).not.toContain("tokens");
    await click(button("Check again"));
    expect(coreJson).toHaveBeenCalledWith(
      "/api/models/sources/added/check",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("offers to retry when no check is running and no result was saved", async () => {
    vi.mocked(coreJson).mockResolvedValue({ sources: [], apps: [] });
    await showCheck({ ...added, check: undefined });
    expect(text()).toContain("The check didn't finish");
    expect(text()).not.toContain("Asking it one short question");
    await click(button("Check again"));
    expect(coreJson).toHaveBeenCalledWith(
      "/api/models/sources/added/check",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each([
    ["Check again", { ...added, check: undefined }, "The check didn't start"],
    ["Switch to GPT-5 Mini", added, "Your home didn't switch to GPT-5 Mini"],
  ] as const)(
    "shows an error and allows another try after %s fails",
    async (label, source, message) => {
      vi.mocked(coreJson).mockRejectedValueOnce(new Error("disconnected"));
      vi.mocked(coreJson).mockResolvedValueOnce({ sources: [], apps: [] });
      const { onChanged } = await showCheck(source);
      await click(button(label));
      expect(problemLines(document.querySelector('[role="alert"]'))).toEqual([
        message,
        "Sanctum didn't answer. Check that it's on, then try again.",
      ]);
      expect((button(label) as HTMLButtonElement).disabled).toBe(false);
      await click(button(label));
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(onChanged).toHaveBeenCalledOnce();
    },
  );

  it("identifies an Ollama model refusal during a check", async () => {
    await showCheck({
      ...mac,
      check: { at: added.check!.at, outcome: "failed", problem: "refused" },
    });
    expect(text()).toContain(
      "Ollama refused the check. The model may not support tools.",
    );
    expect(text()).not.toContain("tokens");
  });

  it("leaves out the token count when usage is unavailable", async () => {
    await showCheck({
      ...added,
      check: { ...added.check!, tokens: undefined },
    });
    expect(text()).toContain("is ready");
    expect(text()).toContain("Answered in 1.2 s");
    expect(text()).not.toMatch(/used \d+ tokens?/i);
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
    expect(text()).toContain("GPT-5 Mini may not act on your devices");
    await click(button("Choose another model"));
    expect(
      document.querySelector('[role="dialog"] [data-slot="dialog-description"]')
        ?.textContent,
    ).toBe("The check uses up to about 1,000 tokens.");
    expect(button("Change and check").disabled).toBe(true);
    await click(
      document.querySelector<HTMLButtonElement>(
        'button[data-slot="popover-trigger"]',
      )!,
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

  it("explains how to get another model when Ollama only lists the current one", async () => {
    vi.mocked(coreJson).mockResolvedValue({
      found: true,
      models: [{ id: mac.model, name: mac.modelName }],
    });
    await showCheck({ ...mac, check: { ...added.check!, outcome: "noTool" } });
    await click(button("Choose another model"));
    expect(text()).toContain("This source has no other models to choose from.");
    expect(text()).toContain("run ollama pull on that computer");
    expect(document.querySelector('[data-slot="popover-trigger"]')).toBeNull();
    await click(button("Back"));
    expect(text()).toContain("may not act on your devices");
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
    document.querySelector<HTMLButtonElement>(
      'button[data-slot="popover-trigger"]',
    )!;
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
    const popup = document.getElementById(
      trigger().getAttribute("aria-controls")!,
    );
    expect(popup?.getAttribute("role")).toBe("dialog");
    expect(popup?.contains(search())).toBe(true);
    expect(search().placeholder).toBe("Search 4 models");
    expect(headings()).toEqual(["Anthropic", "OpenAI"]);
    expect(rows()).toEqual([
      "Claude Sonnet 5.5",
      "Claude Haiku 5.5",
      "GPT-5 Mini",
      "Auto Router",
    ]);
  });

  it("limits visible rows while searching the full catalog", async () => {
    const list = Array.from({ length: 130 }, (_, i) => ({
      id: `model-${i}`,
      name: `Maker: Model ${i}`,
    }));
    const onChange = await showPicker("", list);
    await click(trigger());
    expect(rows()).toHaveLength(100);
    expect(text()).toContain("Showing 100 of 130 models.");
    await type(search(), "model");
    expect(rows()).toHaveLength(100);
    await type(search(), "129");
    expect(rows()).toEqual(["Model 129"]);
    await click(document.querySelector<HTMLElement>("[cmdk-item]")!);
    expect(onChange).toHaveBeenCalledWith("model-129");
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
