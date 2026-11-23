// @vitest-environment jsdom
import type { AppInfo } from "@meetsanctum/app-sdk";
import { AppScope, type AppClient } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OllamaStatus } from "../../src/index";
import ui from "../../src/ui/index";

// Ollama's page: what this Sanctum has, the models on it and downloading,
// and those it could download, held back on a processor that's likely too
// slow until the household says Download anyway. Removing a model asks
// first.

const gb = 1_000_000_000;

const capable = (): OllamaStatus => ({
  isAnswering: true,
  host: {
    processor: { name: "Intel(R) N150", cores: 4, isLikelySlow: false },
    memory: { totalBytes: 16 * gb, roomBytes: 8 * gb },
    storage: { freeBytes: 180 * gb },
  },
  models: [
    {
      id: "qwen3:4b",
      name: "Qwen3 4B",
      sizeBytes: 2.5 * gb,
      memoryBytes: 3.2 * gb,
    },
  ],
  downloads: [
    {
      id: "qwen3:1.7b",
      name: "Qwen3 1.7B",
      completedBytes: 0.6 * gb,
      totalBytes: 1.4 * gb,
      bytesPerSecond: 6_700_000,
    },
  ],
  offered: [
    {
      id: "qwen3:8b",
      name: "Qwen3 8B",
      sizeBytes: 5.2 * gb,
      memoryBytes: 6.5 * gb,
      note: "better answers, slower",
      isSuggested: false,
    },
  ],
});

const slow = (): OllamaStatus => ({
  isAnswering: true,
  host: {
    processor: { name: "Raspberry Pi 4 Model B", cores: 4, isLikelySlow: true },
    memory: { totalBytes: 8 * gb, roomBytes: 4 * gb },
    storage: { freeBytes: 41 * gb },
  },
  models: [],
  downloads: [],
  offered: [
    {
      id: "qwen3:1.7b",
      name: "Qwen3 1.7B",
      sizeBytes: 1.4 * gb,
      memoryBytes: 2 * gb,
      isSuggested: true,
    },
  ],
});

function fakeClient(status: OllamaStatus) {
  const app = {
    id: "sanctum.ollama",
    name: "Ollama",
    version: "0.1.0",
    icon: { glyph: "cpu", color: "iris" },
    pages: ["main"],
    permissions: ["services:ollama"],
    requests: [],
    state: "running",
    settings: null,
    provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
  } as unknown as AppInfo;
  const call = vi.fn(async (action: string) =>
    action === "ollama.status" ? status : {},
  );
  const client = {
    app,
    call,
    subscribe: () => () => {},
  } as unknown as AppClient;
  return { client, call };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function show(client: AppClient) {
  const Main = ui.pages.main!;
  await act(async () => {
    root.render(
      <AppScope client={client}>
        <Main
          params={{}}
          open={() => {}}
          back={() => {}}
          openSettings={() => {}}
        />
      </AppScope>,
    );
  });
  return container.textContent ?? "";
}

const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (each) => each.textContent === name,
  )!;

describe("Ollama's page", () => {
  it("shows this Sanctum, its models, a download under way and what it could download", async () => {
    const text = await show(fakeClient(capable()).client);

    expect(text).toContain("Processor: Intel(R) N150, 4 cores");
    expect(text).toContain("Memory: 16 GB, with 8 GB free for models");
    expect(text).toContain("Storage: 180 GB free");
    expect(text).toContain("Qwen3 4B2.5 GB · uses about 3.2 GB of memory");
    expect(text).toContain(
      "Downloading · 0.6 of 1.4 GB · about 2 minutes left",
    );
    expect(
      container
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow"),
    ).toBe("43");
    expect(text).toContain(
      "5.2 GB · uses about 6.5 GB of memory · better answers, slower",
    );
    expect(button("Download").disabled).toBe(false);
  });

  it("holds downloads back on a processor that's likely too slow until Download anyway", async () => {
    const { client, call } = fakeClient(slow());
    const text = await show(client);

    expect(text).toContain(
      "Processor: Raspberry Pi 4 Model B, 4 cores. Likely too slow",
    );
    expect(text).toContain("suggested for this Sanctum");
    expect(button("Download").disabled).toBe(true);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    });
    await act(async () => button("Download").click());

    expect(call).toHaveBeenCalledWith("ollama.download", {
      model: "qwen3:1.7b",
      anyway: true,
    });
  });

  it("asks before removing a model", async () => {
    const { client, call } = fakeClient(capable());
    await show(client);

    await act(async () => button("Remove").click());
    expect(container.textContent).toContain(
      "Remove Qwen3 4B? Downloading it again takes a while.",
    );
    expect(call).not.toHaveBeenCalledWith("ollama.remove", expect.anything());

    await act(async () => button("Remove").click());
    expect(call).toHaveBeenCalledWith("ollama.remove", { model: "qwen3:4b" });
  });
});
