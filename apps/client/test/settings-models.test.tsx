// @vitest-environment jsdom
import { homeClock } from "@meetsanctum/app-sdk/clock";
import type {
  AppInfo,
  ModelSourceInfo,
  ModelsInfo,
} from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { ModelsPage } from "../src/models/models-page";
import { checkLine, sourceDetail, sourceName } from "../src/models/words";

// The device's own zone, which the expectations here are worked out in.
const clock = homeClock();

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
const anthropic: ModelSourceInfo = {
  id: "anthropic",
  kind: "anthropic",
  model: "claude-sonnet-5-5",
  modelName: "Claude Sonnet 5.5",
  keyEnd: "7c1d",
  inUse: false,
  tokens: { today: 0, month: 0 },
};

// Thirty days of tokens, the same each day, for each source and app.
function usageOf(
  bySource: Record<string, number>,
  byApp: Record<string, number> = {},
): ModelsInfo["usage"] {
  const days = Array.from({ length: 30 }, (_, at) => {
    const day = new Date(now);
    day.setUTCDate(day.getUTCDate() - (29 - at));
    return day.toISOString().slice(0, 10);
  });
  const each = (tokens: number) => days.map(() => tokens);
  return {
    days,
    sources: Object.entries(bySource).map(([id, tokens]) => ({
      id,
      tokens: each(tokens),
    })),
    apps: Object.entries(byApp).map(([id, tokens]) => ({
      id,
      tokens: each(tokens),
    })),
    checks: each(0),
  };
}

const ollamaApp = {
  id: "sanctum.ollama",
  name: "Ollama",
  version: "0.1.0",
  icon: { glyph: "cpu", color: "iris" },
  pages: ["main"],
  permissions: ["services:ollama"],
  requests: [],
  state: "running",
  settings: null,
} as unknown as AppInfo;
const ollamaOffer = {
  id: "sanctum.ollama",
  name: "Ollama",
  version: "0.1.0",
  summary: "AI models on Sanctum itself, so what's asked stays in your home.",
  icon: { glyph: "cpu", color: "iris" },
  requests: [
    {
      id: "services:ollama",
      reason: "To run AI models on Sanctum.",
      needed: true,
      asked: null,
      startsOn: false,
    },
  ],
  shortfalls: [],
};
let sanctumModels: { id: string; name: string; size?: number }[];
let isOllamaAvailable: boolean;

let container: HTMLDivElement;
let root: Root;
let sources: ModelSourceInfo[];
let apps: ModelsInfo["apps"];
let usage: ModelsInfo["usage"] | undefined;
let installed: AppInfo[];
let requests: [string, string, unknown][];
const live = createLiveFeed();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Tokens used measures its width, which jsdom never lays out.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  sources = [mac, router];
  apps = [];
  usage = usageOf({ mac: 100, router: 50 });
  installed = [];
  requests = [];
  sanctumModels = [];
  isOllamaAvailable = true;
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
    const method = init.method ?? "GET";
    requests.push([method, path, init.json]);
    const info = () => ({ sources, apps, ...(usage && { usage }) });
    if (path === "/api/models") return info() as never;
    if (path === "/api/apps/available") return [ollamaOffer] as never;
    if (path === "/api/apps/add") {
      installed = [...installed, ollamaApp];
      return ollamaApp as never;
    }
    if (path === "/api/models/look") {
      const asked = init.json as { kind: string; address?: string };
      if (asked.kind === "sanctum") {
        return isOllamaAvailable
          ? ({ found: true, models: sanctumModels } as never)
          : ({ found: false, problem: "unreachable" } as never);
      }
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
    if (path === "/api/models/sources/anthropic" && method === "PATCH") {
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const openApp = vi.fn();

async function show() {
  // As the shell does, an app added in the sheet comes back in the list.
  const render = () =>
    root.render(
      <ModelsPage
        live={live}
        page={null}
        apps={installed}
        onOpenApp={openApp}
        onAppAdded={(app) => {
          installed = [...installed.filter((each) => each.id !== app.id), app];
          render();
        }}
      />,
    );
  await act(async () => render());
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
const place = (name: string) =>
  [
    ...document.querySelectorAll<HTMLButtonElement>('[role="group"] button'),
  ].find((candidate) => candidate.textContent?.startsWith(name))!;
const click = (element: HTMLElement) =>
  act(async () => {
    element.click();
  });
const labelled = (name: string) =>
  [...document.querySelectorAll<HTMLInputElement>("input")].find(
    (input) => input.labels?.[0]?.textContent === name,
  )!;

async function selectMenuItem(action: string, source = mac) {
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${sourceName(source)}: more"]`,
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
    const sanctum = { ...mac, kind: "sanctum" as const, computer: undefined };
    expect(sourceName(sanctum)).toBe("Qwen3 8B on Sanctum");
    expect(sourceDetail(sanctum)).toBe("Ollama");
    expect(sourceDetail(mac)).toBe("Ollama at 192.168.1.40:11434");
    expect(sourceDetail(router)).toBe("Key ending in 4f2a");
  });

  it("says how the last check went", () => {
    expect(checkLine(clock, mac, now)).toEqual({
      text: "Answered in 2.1 s and used the tool · checked 5 minutes ago",
      tone: "good",
    });
    expect(checkLine(clock, router, now)?.text).toBe(
      "Answered, but may not use your home's AI tools well or act on your devices",
    );
    expect(
      checkLine(
        clock,
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
      checkLine(clock, { ...mac, downSince: "2026-11-23T11:02:00Z" }, now)
        ?.text,
    ).toContain("Check that Office Mac is awake and Ollama is running there.");
    expect(
      checkLine(
        clock,
        {
          ...router,
          downSince: "2026-11-23T11:02:00Z",
          check: { at: now.toISOString(), outcome: "failed", problem: "key" },
        },
        now,
      )?.text,
    ).toContain("OpenRouter didn't take that key.");
    expect(checkLine(clock, { ...mac, checking: true }, now)?.tone).toBe(
      "plain",
    );
  });
});

describe("Settings → AI models", () => {
  it("shows the source in use first, the others with Use, and their tokens", async () => {
    await show();
    const text = container.textContent ?? "";
    expect(text).toContain("Qwen3 8B on Office Mac");
    expect(text).toContain("Ollama at 192.168.1.40:11434");
    expect(text).not.toContain("in your home");
    expect(text).toContain("Other Sources");
    expect(text).toContain("Key ending in 4f2a");
    expect(text).not.toContain("leaves your home");
    expect(text).toContain("Tokens Used4,500 tokens in the last 30 days");
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

  it("shows the tokens of the last 30 days by model, or by app", async () => {
    apps = [
      {
        id: "sanctum.example",
        name: "Example",
        tokens: { today: 0, month: 0 },
      },
    ];
    installed = [{ ...ollamaApp, id: "sanctum.former", name: "Former" }];
    usage = usageOf(
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
        ...container.querySelectorAll(
          '[aria-labelledby="settings-models-tokens"] ul:not(.sr-only) > li',
        ),
      ].map((each) => each.textContent);

    expect(sums()).toEqual([
      "Qwen3 8B on Office Mac3,000",
      "OpenAI: GPT-5 Mini with OpenRouter1,500",
    ]);
    expect(
      container
        .querySelector('[aria-label^="Tokens used"]')
        ?.getAttribute("aria-label"),
    ).toContain("by model");

    await click(
      [...container.querySelectorAll("button")].find(
        (each) => each.textContent === "Apps",
      )!,
    );
    expect(sums()).toEqual(["Example3,000", "Former1,500", "Other apps900"]);
  });

  it("keeps the totals and source choices that an older core supports", async () => {
    usage = undefined;
    await show();
    expect(container.textContent).toContain("Today 46 · last 30 days 1,046");
    expect(container.querySelector('[aria-label^="Tokens used"]')).toBeNull();

    await click(button("Add a source"));
    expect(document.querySelectorAll('input[name="where"]')).toHaveLength(2);
    await click(button("Continue"));
    expect(labelled("Address")).toBeDefined();
  });

  it("reads one day's tokens with the arrow keys", async () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    usage!.sources[0]!.tokens[28] = 175;
    await show();
    const chart = container.querySelector<HTMLElement>(
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
    const previousDay = new Date("2026-11-22T12:00:00Z").toLocaleDateString(
      undefined,
      { day: "numeric", month: "short", timeZone: "America/Los_Angeles" },
    );
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
    usage!.sources[0]!.tokens[3] = 125;
    usage!.sources[0]!.tokens[4] = 175;
    await show();
    const chart = container.querySelector<HTMLElement>(
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
    apps = [
      {
        id: "sanctum.example",
        name: "Example",
        tokens: { today: 0, month: 0 },
      },
    ];
    installed = [
      { ...ollamaApp, id: "sanctum.example", name: "Example" } as AppInfo,
    ];
    await show();
    const text = container.textContent ?? "";

    expect(text).toContain("Apps That Use It");
    expect(text).toContain("ExampleHasn't asked in the last 30 days");
    await click(button("Open"));
    expect(openApp).toHaveBeenCalledWith("sanctum.example");
  });

  it("says when no app uses it, or nothing has used any tokens", async () => {
    usage = usageOf({ mac: 0, router: 0 });
    await show();
    const text = container.textContent ?? "";

    expect(text).toContain("No app uses your home's AI model yet.");
    expect(text).toContain("None in the last 30 days.");
    expect(container.querySelector('[aria-label^="Tokens used"]')).toBeNull();
    expect(
      [...container.querySelectorAll("button")].some(
        (each) => each.textContent === "Apps",
      ),
    ).toBe(false);
  });

  it("offers where the model can run when the home has none", async () => {
    sources = [];
    await show();
    const text = container.textContent ?? "";
    expect(text).toContain("No AI model yet");
    expect(text).toContain("It's the brain of your home.");
    expect(text).not.toContain("Tokens Used");
    // The places are the way in, so the bar has no Add a source.
    expect(button("Add a source")).toBeUndefined();
    const group = container.querySelector('[role="group"]')!;
    expect(
      document.getElementById(group.getAttribute("aria-labelledby")!)
        ?.textContent,
    ).toBe("No AI model yet");
    expect(
      [...group.querySelectorAll("button")].map((each) => each.textContent),
    ).toEqual([
      "On SanctumWith the Ollama app.Stays in your home",
      "On a computer in your homeA Mac or PC that runs Ollama.Stays in your home",
      "With an AI providerOpenRouter, Anthropic or OpenAI, with your own API key.Leaves your home",
    ]);
  });

  it("leaves out On Sanctum where Ollama can't run on it", async () => {
    sources = [];
    usage = undefined;
    await show();
    expect(
      [...container.querySelectorAll('[role="group"] button')].map(
        (each) => each.textContent?.split("With")[0]?.split("A Mac")[0],
      ),
    ).toEqual(["On a computer in your home", ""]);
  });

  it("starts Add a source at the place chosen, and gives focus back to it", async () => {
    sources = [];
    await show();
    const provider = place("With an AI provider");
    await click(provider);
    expect(document.querySelector('input[name="where"]')).toBeNull();
    expect(document.body.textContent).toContain("What goes to OpenRouter");
    await type(labelled("API key"), "sk-or-v1-test-key-4f2a");
    await click(button("Check key"));
    expect(document.body.textContent).toContain("The key works");

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(document.querySelector("[role=dialog]")).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(provider));

    await click(place("On a computer in your home"));
    expect(labelled("Address")).toBeDefined();
    expect(document.body.textContent).not.toContain("The key works");
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

  it("replaces the key for a saved Anthropic source", async () => {
    sources.push(anthropic);
    await show();
    await selectMenuItem("Replace key", anthropic);
    await type(
      document.querySelector<HTMLInputElement>('input[aria-label="API key"]')!,
      "sk-ant-api03-new-test-key",
    );
    await click(button("Save"));

    expect(requests).toContainEqual([
      "PATCH",
      "/api/models/sources/anthropic",
      { key: "sk-ant-api03-new-test-key" },
    ]);
    expect(document.querySelector("[role=dialog]")).toBeNull();
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
      2,
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

  it("checks only the key entered for the selected provider", async () => {
    await show();
    await click(button("Add a source"));
    await click(
      document.querySelectorAll<HTMLInputElement>('input[name="where"]')[2]!,
    );
    await click(button("Continue"));
    const key = labelled("API key");
    await type(key, "sk-or-v1-test-key-4f2a");
    expect(document.body.textContent).not.toContain("keeps the start");
    await click(button("Anthropic"));
    expect(document.body.textContent).toContain(
      "Anthropic keeps the start of a conversation for a few minutes to answer faster.",
    );
    expect(key.value).toBe("");
    expect(button("Check key").disabled).toBe(true);
    expect(requests.filter(([, path]) => path === "/api/models/look")).toEqual(
      [],
    );

    await type(key, "sk-ant-api03-test-key-7c1d");
    await click(button("Check key"));
    expect(requests).toContainEqual([
      "POST",
      "/api/models/look",
      { kind: "anthropic", key: "sk-ant-api03-test-key-7c1d" },
    ]);
  });

  it("adds Ollama on Sanctum, then points to its page for a model", async () => {
    // Ollama doesn't answer yet while its image downloads.
    isOllamaAvailable = false;
    await show();
    await click(button("Add a source"));
    await click(button("Continue"));

    expect(document.body.textContent).toContain(
      "Add the Ollama app, then download a model on its page.",
    );
    expect(document.body.textContent).toContain("Use Ollama");
    await click(button("Add Ollama"));
    expect(requests).toContainEqual([
      "POST",
      "/api/apps/add",
      { id: "sanctum.ollama", version: "0.1.0" },
    ]);
    expect(document.body.textContent).toContain("Ollama is added to Sanctum");
    expect(document.body.textContent).toContain(
      "Go to the Ollama app to download a model.",
    );
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(requests.filter(([, path]) => path === "/api/models/look")).toEqual(
      [],
    );

    await click(button("Open Ollama"));
    expect(openApp).toHaveBeenCalledWith("sanctum.ollama");
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("reports an unreachable Ollama without saying it needs a model", async () => {
    installed = [ollamaApp];
    isOllamaAvailable = false;
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

  it("adds one of the models Ollama on Sanctum has", async () => {
    installed = [ollamaApp];
    sanctumModels = [
      { id: "qwen3:4b", name: "Qwen3 4B", size: 2_500_000_000 },
      { id: "qwen3:1.7b", name: "Qwen3 1.7B", size: 1_400_000_000 },
    ];
    await show();
    await click(button("Add a source"));
    await click(button("Continue"));

    expect(document.body.textContent).toContain("Choose a model.");
    expect(document.body.textContent).toContain("qwen3:4b · 2.5 GB");
    await click(labelled("Qwen3 1.7Bqwen3:1.7b · 1.4 GB"));
    await click(button("Add and check"));
    expect(requests).toContainEqual([
      "POST",
      "/api/models/sources",
      { kind: "sanctum", model: "qwen3:1.7b" },
    ]);
  });
});
