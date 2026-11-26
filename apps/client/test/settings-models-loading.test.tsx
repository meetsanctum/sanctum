// @vitest-environment jsdom
import { createLiveFeed, PageBarSlot } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackButton } from "../src/components";
import { coreJson } from "../src/core-fetch";
import type { ModelsResponse } from "../src/models/data";
import { ModelsPage } from "../src/models/models-page";
import { sourceName } from "../src/models/words";
import { mac } from "./settings-models-fixtures";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

let bar: HTMLDivElement;
let body: HTMLDivElement;
let root: Root;
const fetchModels = vi.mocked(coreJson<ModelsResponse>);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchModels.mockReset();
  bar = document.createElement("div");
  body = document.createElement("div");
  document.body.append(bar, body);
  root = createRoot(body);
});

afterEach(async () => {
  await act(async () => root.unmount());
  bar.remove();
  body.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const button = (name: string, within: HTMLElement) =>
  [...within.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  );

async function show(onBack = vi.fn()) {
  const live = createLiveFeed();
  await act(async () => {
    root.render(
      <PageBarSlot.Provider value={bar}>
        <ModelsPage
          live={live}
          page={<BackButton to="Settings" onBack={onBack} />}
          apps={[]}
        />
      </PageBarSlot.Provider>,
    );
  });
}

function holdReply() {
  let reply!: (info: ModelsResponse) => void;
  const promise = new Promise<ModelsResponse>((resolve) => (reply = resolve));
  return { promise, reply };
}

describe("Loading AI Models", () => {
  it("shows only the bar and keeps Back focused when the first answer arrives", async () => {
    const { promise, reply } = holdReply();
    fetchModels.mockReturnValueOnce(promise);
    const onBack = vi.fn();
    await show(onBack);
    const back = bar.querySelector<HTMLButtonElement>(
      'button[aria-label="Back to Settings"]',
    )!;
    expect(bar.querySelector("h1")?.textContent).toBe("AI Models");
    expect(body.textContent).toBe("");
    expect(body.querySelector("#settings-models")).toBeNull();
    expect(button("Add a source", bar)).toBeUndefined();
    back.focus();
    expect(document.activeElement).toBe(back);

    await act(async () => reply({ sources: [], apps: [] }));
    expect(body.textContent).toContain("No AI model yet");
    expect(button("Add a source", bar)).toBeUndefined();
    expect(document.activeElement).toBe(back);
    back.click();
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("offers a manual retry after the first request fails", async () => {
    const { promise, reply } = holdReply();
    fetchModels
      .mockRejectedValueOnce(new Error("Request failed"))
      .mockReturnValueOnce(promise);
    await show();
    expect(body.querySelector('[role="alert"]')?.textContent).toContain(
      "AI models couldn't load.",
    );
    expect(button("Add a source", bar)).toBeUndefined();

    const retry = button("Try again", body)!;
    await act(async () => retry.click());
    expect(coreJson).toHaveBeenCalledTimes(2);
    expect(retry.disabled).toBe(true);

    await act(async () => reply({ sources: [], apps: [] }));
    expect(body.querySelector('[role="alert"]')).toBeNull();
    expect(body.textContent).toContain("No AI model yet");
  });

  it("shows the configured source when polling recovers from a failed first request", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fetchModels
      .mockRejectedValueOnce(new Error("Request failed"))
      .mockResolvedValueOnce({ sources: [mac], apps: [] });
    await show();
    expect(body.querySelector('[role="alert"]')).not.toBeNull();
    expect(button("Add a source", bar)).toBeUndefined();

    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(coreJson).toHaveBeenCalledTimes(2);
    expect(body.querySelector('[role="alert"]')).toBeNull();
    expect(body.querySelector("#settings-models")?.textContent).toContain(
      sourceName(mac),
    );
    expect(button("Add a source", bar)).toBeDefined();
  });
});
