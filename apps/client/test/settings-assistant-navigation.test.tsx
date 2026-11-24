// @vitest-environment jsdom
import { createLiveFeed, type PageParams } from "@meetsanctum/ui-sdk";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { SettingsPage } from "../src/settings";
import { unknownHome } from "./home-fixtures";
import { assistant, canUseWith, example } from "./settings-agents-fixtures";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

it("opens assistant settings and lets an assistant-only home change an app's offers", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(coreJson).mockImplementation(async (path, init) => {
    switch (path) {
      case "/api/auth/agents":
      case "/api/auth/clients":
      case "/api/workflows":
      case `/api/entities?app=${assistant.id}`:
      case `/api/entities?app=${example.id}`:
        return [];
      case "/api/models":
        return { sources: [] };
      case "/api/agents/can-use":
        return canUseWith();
      case "/api/agents/can-use/offer": {
        const { id, on } = init?.json as { id: string; on: boolean };
        return canUseWith({ [id]: on });
      }
      default:
        throw new Error(`Unexpected request: ${path}`);
    }
  });

  const live = createLiveFeed();
  function Settings() {
    const [{ page, params }, open] = useState<{
      page: string;
      params: PageParams;
    }>({ page: "main", params: {} });
    return (
      <SettingsPage
        page={page}
        params={params}
        open={(page, params = {}) => open({ page, params })}
        back={() => undefined}
        apps={[example, assistant]}
        core={{ state: "online", version: "1.2.3" }}
        live={live}
        devices={{ devices: [], places: undefined }}
        home={unknownHome}
        onUpdating={() => undefined}
      />
    );
  }

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const click = (text: string) =>
    act(async () => {
      const button = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === text,
      );
      expect(button, text).toBeDefined();
      button!.click();
    });
  const title = () => container.querySelector("h1")?.textContent;
  const switchFor = (name: string) =>
    container.querySelector<HTMLButtonElement>(
      `[role="switch"][aria-label="${name}"]`,
    )!;

  try {
    await act(async () => root.render(<Settings />));
    await click("AI Agents1 agent");
    await click("AssistantSanctum app");
    expect(title()).toBe("Assistant Settings");

    await click("What AI Agents Can Use");
    expect(title()).toBe("What AI Agents Can Use");
    await click("Example2 of 3 on");
    expect(title()).toBe("Example Settings");

    const action = switchFor("Run a scene");
    expect(action.getAttribute("aria-checked")).toBe("true");
    expect(switchFor("Scenes in each room").getAttribute("aria-checked")).toBe(
      "true",
    );
    await act(async () => action.click());
    expect(coreJson).toHaveBeenCalledWith(
      "/api/agents/can-use/offer",
      expect.objectContaining({
        method: "POST",
        json: { app: example.id, id: "example.run", on: false },
      }),
    );
    expect(action.getAttribute("aria-checked")).toBe("false");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
