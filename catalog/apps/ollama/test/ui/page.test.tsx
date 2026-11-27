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
      memory: { neededBytes: 6.5 * gb, roomBytes: 8 * gb, state: "tight" },
      storage: { neededBytes: 5.2 * gb, roomBytes: 178 * gb, state: "fits" },
      fits: true,
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
      memory: { neededBytes: 2 * gb, roomBytes: 4 * gb, state: "fits" },
      storage: { neededBytes: 1.4 * gb, roomBytes: 39 * gb, state: "fits" },
      fits: true,
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
  vi.useRealTimers();
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
          openDevice={() => {}}
          addDevices={() => {}}
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
    expect(text).toContain("Download a model8 GB of memory free for models");
    expect(text).toContain(
      "Qwen3 8B5.2 GB downloadTight · uses 6.5 of 8 GB memory",
    );
    expect(button("Download").disabled).toBe(false);
  });

  it("holds downloads back on a processor that's likely too slow until Download anyway", async () => {
    const { client, call } = fakeClient(slow());
    const text = await show(client);

    expect(text).toContain(
      "Processor: Raspberry Pi 4 Model B, 4 cores. Likely too slow",
    );
    expect(text).toContain("Qwen3 1.7B1.4 GB downloadUses 2 of 4 GB memory");
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

  it("shows the result of a progress poll that takes longer than the polling interval", async () => {
    vi.useFakeTimers();
    const { client, call } = fakeClient(capable());
    await show(client);
    let respond!: (status: OllamaStatus) => void;
    const response = new Promise<OllamaStatus>(
      (resolve) => (respond = resolve),
    );
    call.mockImplementationOnce(() => response);
    call.mockClear();

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(call).toHaveBeenCalledTimes(1);

    const updated = capable();
    updated.downloads[0]!.completedBytes = 1 * gb;
    await act(async () => respond(updated));

    expect(container.textContent).toContain("Downloading · 1.0 of 1.4 GB");
  });

  it("still lets someone stop a download when the model list is unavailable", async () => {
    const { client, call } = fakeClient({ ...capable(), isAnswering: false });
    await show(client);

    await act(async () => button("Stop download").click());
    expect(call).toHaveBeenCalledWith("ollama.stop", { model: "qwen3:1.7b" });
  });

  it("shows what each model takes, and keeps one too large listed with Download off", async () => {
    const little = slow();
    little.host.processor.isLikelySlow = false;
    const room = { memory: 4 * gb, storage: 2.4 * gb };
    const offer = (
      name: string,
      sizeBytes: number,
      memoryBytes: number,
      memory: "fits" | "tight" | "tooLarge",
      storage: "fits" | "tight" | "tooLarge",
    ) => ({
      id: name.toLowerCase().replace(/ /g, "-"),
      name,
      sizeBytes,
      memoryBytes,
      memory: {
        neededBytes: memoryBytes,
        roomBytes: room.memory,
        state: memory,
      },
      storage: {
        neededBytes: sizeBytes,
        roomBytes: room.storage,
        state: storage,
      },
      fits: memory !== "tooLarge" && storage !== "tooLarge",
    });
    little.offered = [
      offer("Llama 3.2 3B", 2 * gb, 2.8 * gb, "fits", "tight"),
      offer("Qwen3 4B", 2.5 * gb, 3.2 * gb, "tight", "tooLarge"),
    ];
    const text = await show(fakeClient(little).client);

    expect(text).toContain(
      "Download a model4 GB of memory and 2.4 GB of storage free for models",
    );
    expect(text).toContain(
      "Llama 3.2 3BTight · needs 2 of 2.4 GB storageUses 2.8 of 4 GB memory",
    );
    expect(text).toContain(
      "Qwen3 4BToo large · needs 2.5 of 2.4 GB storageTight · uses 3.2 of 4 GB memory",
    );
    const downloads = [...container.querySelectorAll("button")].filter(
      (each) => each.textContent === "Download",
    );
    expect(downloads.map((each) => each.disabled)).toEqual([false, true]);
    expect(
      [...container.querySelectorAll('svg[role="img"]')].map((each) =>
        each.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Llama 3.2 3B takes 70% of the memory free for models",
      "Qwen3 4B takes 80% of the memory free for models",
    ]);
  });

  it("asks before removing a model", async () => {
    const { client, call } = fakeClient(capable());
    await show(client);

    await act(async () => button("Remove").click());
    expect(container.textContent).toContain(
      "Remove Qwen3 4B? Downloading it again takes a while.",
    );
    expect(call).not.toHaveBeenCalledWith("ollama.remove", expect.anything());
    expect(document.activeElement).toBe(button("Keep it"));
    await act(async () => button("Keep it").click());
    expect(document.activeElement).toBe(button("Remove"));

    await act(async () => button("Remove").click());
    await act(async () => button("Remove").click());
    expect(call).toHaveBeenCalledWith("ollama.remove", { model: "qwen3:4b" });
  });
});
