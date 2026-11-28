import type {
  AddModelSource,
  AppInfo,
  AvailableApp,
  ModelChoice,
  ModelSourceInfo,
  ModelsInfo,
} from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { ModelsPage } from "../src/models/models-page";
import { sourceName } from "../src/models/words";
import {
  SettingsOpenerProvider,
  type SettingsOpener,
} from "../src/settings-opener";
import { mac, now, router } from "./settings-models-fixtures";

export const anthropic: ModelSourceInfo = {
  id: "anthropic",
  kind: "anthropic",
  model: "claude-sonnet-5-5",
  modelName: "Claude Sonnet 5.5",
  keyEnd: "7c1d",
  inUse: false,
  tokens: { today: 0, month: 0 },
};

// Thirty days of tokens, the same each day, for each source and app.
export function usageOf(
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

export const ollamaApp = {
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
const ollamaOffer: AvailableApp = {
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
  memory: 128,
  data: 256,
  servicesMemory: 4096,
  adds: { devices: false },
  shortfalls: [],
};
let root: Root;
export const page = {
  container: document.createElement("div"),
  sources: [] as ModelSourceInfo[],
  apps: [] as ModelsInfo["apps"],
  usage: undefined as ModelsInfo["usage"] | undefined,
  installed: [] as AppInfo[],
  requests: [] as [string, string, unknown][],
  sanctumModels: [] as ModelChoice[],
  offeredModels: [] as ModelChoice[],
  isOllamaAvailable: true,
  ollamaShortfalls: [] as AvailableApp["shortfalls"],
  includeAddedSourceId: true,
};
export const live = createLiveFeed();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The model list scrolls its chosen row into view, which jsdom lacks.
  Element.prototype.scrollIntoView ??= () => {};
  // Tokens used measures its width, which jsdom never lays out.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  page.sources = [mac, router];
  page.apps = [];
  page.usage = usageOf({ mac: 100, router: 50 });
  page.installed = [];
  page.requests = [];
  page.sanctumModels = [];
  page.offeredModels = [
    { id: "llama3.2:3b", name: "Llama3.2 3B", size: 2_000_000_000 },
  ];
  page.isOllamaAvailable = true;
  page.ollamaShortfalls = [];
  page.includeAddedSourceId = true;
  openApp.mockClear();
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
    const method = init.method ?? "GET";
    page.requests.push([method, path, init.json]);
    const info = () => ({
      sources: page.sources,
      apps: page.apps,
      ...(page.usage && { usage: page.usage }),
    });
    if (path === "/api/models") return info() as never;
    if (path === "/api/apps/available") {
      return [{ ...ollamaOffer, shortfalls: page.ollamaShortfalls }] as never;
    }
    if (path === "/api/apps/add") {
      page.installed = [...page.installed, ollamaApp];
      return ollamaApp as never;
    }
    if (path === "/api/models/look") {
      const asked = init.json as { kind: string; address?: string };
      if (asked.kind === "sanctum") {
        return page.isOllamaAvailable
          ? ({ found: true, models: page.sanctumModels } as never)
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
        models: page.offeredModels,
      } as never;
    }
    if (path === "/api/models/sources" && method === "POST") {
      const request = init.json as AddModelSource;
      const choices =
        request.kind === "sanctum" ? page.sanctumModels : page.offeredModels;
      const added: ModelSourceInfo = {
        id: "studio",
        kind: request.kind,
        model: request.model,
        modelName: choices.find((choice) => choice.id === request.model)!.name,
        ...(request.kind === "computer" && {
          address: request.address,
          computer: request.computer,
        }),
        inUse: page.sources.length === 0,
        checking: true,
        tokens: { today: 0, month: 0 },
      };
      page.sources = [...page.sources, added];
      return {
        ...info(),
        ...(page.includeAddedSourceId && { addedSourceId: added.id }),
      } as never;
    }
    if (path === "/api/models/sources/router/use") {
      page.sources = [
        { ...mac, inUse: false },
        { ...router, inUse: true },
      ];
      return info() as never;
    }
    if (path === "/api/models/sources/mac/check" && method === "POST") {
      page.sources = page.sources.map((source) =>
        source.id === "mac" ? { ...source, checking: true } : source,
      );
      return info() as never;
    }
    if (path === "/api/models/sources/mac/models") {
      return {
        found: true,
        models: [{ id: "llama3.2:3b", name: "Llama3.2 3B" }],
      } as never;
    }
    if (path === "/api/models/sources/mac" && method === "PATCH") {
      const change = init.json as { model?: string; computer?: string };
      page.sources = page.sources.map((source) =>
        source.id === mac.id
          ? {
              ...source,
              ...change,
              ...(change.model && {
                modelName: "Llama3.2 3B",
                checking: true,
                check: undefined,
              }),
            }
          : source,
      );
      return info() as never;
    }
    if (path === "/api/models/sources/mac" && method === "DELETE") {
      page.sources = page.sources.filter((source) => source.id !== mac.id);
      return info() as never;
    }
    if (path === "/api/models/sources/anthropic" && method === "PATCH") {
      page.sources = page.sources.map((source) =>
        source.id === anthropic.id
          ? { ...source, keyEnd: "key", checking: true, check: undefined }
          : source,
      );
      return info() as never;
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  document.body.append(page.container);
  root = createRoot(page.container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  page.container.remove();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

export const openApp = vi.fn();

export async function show(openSettings?: SettingsOpener) {
  // As the shell does, an app added in the sheet comes back in the list.
  const render = () =>
    root.render(
      <SettingsOpenerProvider value={openSettings}>
        <ModelsPage
          live={live}
          page={null}
          apps={page.installed}
          onOpenApp={openApp}
          onAppAdded={(app) => {
            page.installed = [
              ...page.installed.filter((each) => each.id !== app.id),
              app,
            ];
            render();
          }}
        />
      </SettingsOpenerProvider>,
    );
  await act(async () => render());
}

export async function enterText(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  )!;
export const place = (name: string) =>
  [
    ...document.querySelectorAll<HTMLButtonElement>('[role="group"] button'),
  ].find((candidate) => candidate.textContent?.startsWith(name))!;
export const click = (element: HTMLElement) =>
  act(async () => {
    element.click();
  });
export const labelled = (name: string) =>
  [...document.querySelectorAll<HTMLInputElement>("input")].find(
    (input) => input.labels?.[0]?.textContent === name,
  )!;

// A model in the dialog's list: the field opens a search over them.
export async function chooseModel(name: string) {
  await click(
    document.querySelector<HTMLButtonElement>(
      '[role="dialog"] button[data-slot="popover-trigger"]',
    )!,
  );
  await click(
    [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((item) =>
      item.textContent?.startsWith(name),
    )!,
  );
}

export async function selectMenuItem(action: string, source = mac) {
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
