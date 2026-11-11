// @vitest-environment jsdom
import type { AppInfo, PieceInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AutomationsPage } from "../src/automations/page";
import { coreJson } from "../src/core-fetch";
import type { useDevices } from "../src/use-devices";
import { devices, pieces, places } from "./automations-fixtures";

// The editor asks for the optional permissions a piece needs as someone adds
// it: through the shell's sheet, and the card goes in only once they are on.

vi.mock("../src/core-fetch", async (original) => ({
  ...(await original()),
  coreJson: vi.fn(),
}));

const addEntry: PieceInfo = {
  kind: "step",
  app: "sanctum.example",
  id: "example.addEntry",
  title: "Add an entry",
  config: { type: "object", properties: {} },
  icon: null,
  sentence: "Add an entry",
  card: null,
  presets: [],
  needs: ["people.read"],
  group: null,
};
const example = {
  id: "sanctum.example",
  name: "Example",
  icon: { glyph: "list", color: "leaf" },
  permissions: [],
  requests: [
    {
      id: "people.read",
      reason: "To say who added it.",
      needed: false,
      asked: "when you add an entry for someone",
      startsOn: false,
    },
  ],
  state: "running",
} as unknown as AppInfo;

let container: HTMLDivElement;
let root: Root;
const ask = vi.fn(
  async (_app: string, _permissions: readonly string[]) => true,
);

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ask.mockClear();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path === "/api/workflows") return [];
    if (path === "/api/workflows/pieces") return [...pieces, addEntry];
    if (path === "/api/entities" || path === "/api/people") return [];
    throw new Error(`Unexpected request: ${path}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <AutomationsPage
        page="edit"
        params={{}}
        open={() => {}}
        back={() => {}}
        apps={[example]}
        devices={
          { places, devices } as unknown as ReturnType<typeof useDevices>
        }
        live={createLiveFeed()}
        openAppSettings={() => {}}
        openStatus={() => {}}
        ask={ask}
      />,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.mocked(coreJson).mockReset();
});

const press = async (text: string) => {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((each) => each.textContent?.trim().startsWith(text));
  if (!button) throw new Error(`No button ${text}`);
  await act(async () => button.click());
};

it("asks for what a piece needs before it goes in, and adds nothing on Not now", async () => {
  ask.mockResolvedValueOnce(false);
  await press("Add a step");
  await press("Add an entry");
  expect(ask).toHaveBeenCalledWith("sanctum.example", ["people.read"]);
  expect(container.textContent).not.toContain("Add an entry");

  await press("Add a step");
  await press("Add an entry");
  expect(ask).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Add an entry");
});

it("adds a piece whose needs are on without asking", async () => {
  await press("Add a step");
  await press("Turn on the lights in Office");
  expect(ask).not.toHaveBeenCalled();
});
