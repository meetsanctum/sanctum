// @vitest-environment jsdom
import type { ModelSourceInfo, ModelsInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { ModelsPage } from "../src/models/models-page";
import { checkLine, sourceName, tokensText } from "../src/models/words";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const now = new Date("2026-11-23T12:00:00Z");
const mac: ModelSourceInfo = {
  id: "mac",
  kind: "computer",
  model: "qwen3:8b",
  modelName: "Qwen3 8B",
  computer: "Office Mac",
  address: "192.168.1.40:11434",
  inUse: true,
  check: { at: "2026-11-23T11:55:00Z", outcome: "answered", firstWordMs: 2100 },
  tokens: { today: 46, month: 1_046 },
};
const router: ModelSourceInfo = {
  id: "router",
  kind: "openrouter",
  model: "openai/gpt-5-mini",
  modelName: "OpenAI: GPT-5 Mini",
  keyEnd: "4f2a",
  inUse: false,
  check: { at: "2026-11-23T11:00:00Z", outcome: "noTool", firstWordMs: 800 },
  tokens: { today: 0, month: 18_400 },
};

let container: HTMLDivElement;
let root: Root;
let sources: ModelSourceInfo[];
let apps: ModelsInfo["apps"];
let requests: [string, string, unknown][];
const live = createLiveFeed();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sources = [mac, router];
  apps = [];
  requests = [];
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
    const method = init.method ?? "GET";
    requests.push([method, path, init.json]);
    const info = (): ModelsInfo => ({ sources, apps });
    if (path === "/api/models") return info() as never;
    if (path === "/api/models/look") {
      const asked = init.json as { kind: string; address?: string };
      if (asked.kind === "computer" && asked.address === "192.168.1.9") {
        return {
          found: false,
          problem: "unreachable",
          address: "192.168.1.9:11434",
        } as never;
      }
      return {
        found: true,
        ...(asked.kind === "computer" ? { address: "192.168.1.50:11434" } : {}),
        models: [
          { id: "llama3.2:3b", name: "Llama3.2 3B", size: 2_000_000_000 },
        ],
      } as never;
    }
    if (path === "/api/models/sources" && method === "POST") {
      sources = [
        ...sources,
        { ...mac, id: "studio", inUse: false, checking: true },
      ];
      return info() as never;
    }
    if (path === "/api/models/sources/router/use") {
      sources = [
        { ...mac, inUse: false },
        { ...router, inUse: true },
      ];
      return info() as never;
    }
    if (path === "/api/models/sources/mac/models") {
      return {
        found: true,
        models: [{ id: "llama3.2:3b", name: "Llama3.2 3B" }],
      } as never;
    }
    if (path === "/api/models/sources/mac" && method === "PATCH") {
      sources = [
        { ...mac, ...(init.json as Partial<ModelSourceInfo>) },
        router,
      ];
      return info() as never;
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function show() {
  await act(async () => {
    root.render(<ModelsPage live={live} page={null} />);
  });
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  )!;
const click = (element: HTMLElement) =>
  act(async () => {
    element.click();
  });
const labelled = (name: string) =>
  [...document.querySelectorAll<HTMLInputElement>("input")].find(
    (input) => input.labels?.[0]?.textContent === name,
  )!;

async function selectMenuItem(action: string) {
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${sourceName(mac)}: more"]`,
  )!;
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  await click(
    [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find(
      (candidate) => candidate.textContent === action,
    )!,
  );
}

describe("the words for AI models", () => {
  it("names a source by its model and where it runs", () => {
    expect(sourceName(mac)).toBe("Qwen3 8B on Office Mac");
    expect(sourceName(router)).toBe("OpenAI: GPT-5 Mini with OpenRouter");
    expect(tokensText(router.tokens)).toBe(
      `Today 0 · last 30 days ${(18_400).toLocaleString()}`,
    );
  });

  it("says how the last check went", () => {
    expect(checkLine(mac, now)).toEqual({
      text: "Answered in 2.1 s and used the tool · checked 5 minutes ago",
      tone: "good",
    });
    expect(checkLine(router, now)?.text).toBe(
      "Answered, but didn't use the tool: it may not handle your home's tools well",
    );
    expect(
      checkLine(
        {
          ...mac,
          check: {
            at: now.toISOString(),
            outcome: "failed",
            problem: "unreachable",
          },
        },
        now,
      ),
    ).toMatchObject({
      text: expect.stringContaining("Nothing answered at 192.168.1.40:11434"),
      tone: "problem",
    });
    expect(
      checkLine({ ...mac, downSince: "2026-11-23T11:02:00Z" }, now)?.text,
    ).toContain("Check that Office Mac is awake and Ollama is running there.");
    expect(
      checkLine(
        {
          ...router,
          downSince: "2026-11-23T11:02:00Z",
          check: { at: now.toISOString(), outcome: "failed", problem: "key" },
        },
        now,
      )?.text,
    ).toContain("OpenRouter didn't take that key.");
    expect(checkLine({ ...mac, checking: true }, now)?.tone).toBe("plain");
  });
});

describe("Settings → AI models", () => {
  it("shows the source in use first, the others with Use, and their tokens", async () => {
    await show();
    const text = container.textContent ?? "";
    expect(text).toContain("Qwen3 8B on Office Mac");
    expect(text).toContain("Ollama at 192.168.1.40:11434 · in your home");
    expect(text).toContain("Other sources");
    expect(text).toContain(
      "Key ending in 4f2a · what's asked leaves your home",
    );
    expect(text).toContain("Tokens used");
    expect(text).not.toContain("sk-");

    await click(button("Use"));
    expect(requests).toContainEqual([
      "POST",
      "/api/models/sources/router/use",
      undefined,
    ]);
    expect(container.textContent).toContain("Qwen3 8B on Office Mac");
    expect(button("Use")).toBeDefined();
  });

  it("lists the apps that may use it, with their tokens", async () => {
    apps = [
      {
        id: "sanctum.example",
        name: "Example",
        tokens: { today: 1_234, month: 5_678 },
      },
    ];
    await show();
    const text = container.textContent ?? "";
    expect(text).toContain("Apps that use it");
    expect(text).toContain("Example");
    expect(text).toContain("Today 1,234 · last 30 days 5,678");
  });

  it("leaves Apps that use it out while none may", async () => {
    await show();
    expect(container.textContent).not.toContain("Apps that use it");
  });

  it("says when the home has no model yet", async () => {
    sources = [];
    await show();
    expect(container.textContent).toContain("Your home has no AI model yet");
    expect(container.textContent).not.toContain("Tokens used");
  });

  it("keeps a typed computer name until it is saved", async () => {
    await show();
    await selectMenuItem("Rename computer");
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Computer"]',
    )!;
    await type(input, "Studio Mac");
    expect(input.value).toBe("Studio Mac");
    await click(button("Save"));
    expect(requests).toContainEqual([
      "PATCH",
      "/api/models/sources/mac",
      { computer: "Studio Mac" },
    ]);
  });

  it("can change to the sole available model when the saved model is gone", async () => {
    await show();
    await selectMenuItem("Change model");
    expect(button("Save").disabled).toBe(false);
    await click(button("Save"));
    expect(requests).toContainEqual([
      "PATCH",
      "/api/models/sources/mac",
      { model: "llama3.2:3b" },
    ]);
  });

  it("adds a computer once Sanctum has found Ollama there", async () => {
    await show();
    await click(button("Add a source"));
    await click(button("Continue"));
    expect(button("Add and check").disabled).toBe(true);

    await type(labelled("Address"), "192.168.1.9");
    await click(button("Check"));
    expect(document.body.textContent).toContain(
      "Nothing answered at 192.168.1.9:11434",
    );

    await type(labelled("Address"), "studio.local");
    await click(button("Check"));
    expect(document.body.textContent).toContain(
      "Found Ollama at 192.168.1.50:11434, with 1 model",
    );
    await type(labelled("Computer"), "Studio Mac");
    await click(button("Add and check"));
    expect(requests).toContainEqual([
      "POST",
      "/api/models/sources",
      {
        kind: "computer",
        address: "192.168.1.50:11434",
        computer: "Studio Mac",
        model: "llama3.2:3b",
      },
    ]);
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("adds a provider once its key works", async () => {
    await show();
    await click(button("Add a source"));
    const provider = [...document.querySelectorAll("input[type=radio]")].at(
      1,
    ) as HTMLInputElement;
    await click(provider);
    await click(button("Continue"));
    expect(document.body.textContent).toContain("What goes to OpenRouter");
    await type(labelled("API key"), "sk-or-v1-test-key-4f2a");
    await click(button("Check key"));
    expect(document.body.textContent).toContain("The key works");
    await click(button("Add and check"));
    expect(requests).toContainEqual([
      "POST",
      "/api/models/sources",
      {
        kind: "openrouter",
        key: "sk-or-v1-test-key-4f2a",
        model: "llama3.2:3b",
      },
    ]);
  });
});
