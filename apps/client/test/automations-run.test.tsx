// @vitest-environment jsdom
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useAutomations } from "../src/automations/data";
import { AutomationsList } from "../src/automations/list";
import { CoreError, coreJson } from "../src/core-fetch";
import { names, pieces, workflow } from "./automations-fixtures";
import { problemLines } from "./problem-lines";

vi.mock("../src/core-fetch", async (original) => ({
  ...(await original<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const movie = workflow({
  id: "movie",
  name: "Movie night",
  graph: {
    version: 1,
    nodes: [{ id: "t", kind: "trigger", piece: "manual", config: {} }],
    edges: [],
  },
});
const reading = { ...movie, id: "reading", name: "Reading lights" };
const live = createLiveFeed();
let workflows: (typeof movie)[];
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  workflows = [movie, reading];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(coreJson).mockImplementation(async (path) => {
    switch (path) {
      case "/api/workflows":
        return workflows;
      case "/api/workflows/pieces":
        return pieces;
      case "/api/entities":
      case "/api/people":
        return [];
      default:
        throw new Error(`Unexpected request: ${path}`);
    }
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.mocked(coreJson).mockReset();
  vi.unstubAllGlobals();
});

function List() {
  const automations = useAutomations(live);
  return (
    <AutomationsList
      automations={automations}
      apps={[]}
      names={names}
      open={() => {}}
    />
  );
}

const alert = () => container.querySelector("[role=alert]");

async function runMovie(error: Error) {
  await act(async () => root.render(<List />));
  const row = [...container.querySelectorAll("li")].find((item) =>
    item.textContent?.includes("Movie night"),
  )!;
  const run = [...row.querySelectorAll("button")].find(
    (button) => button.textContent === "Run",
  )!;
  vi.mocked(coreJson).mockRejectedValueOnce(error);
  await act(async () => run.click());
  expect(coreJson).toHaveBeenCalledWith("/api/workflows/run", {
    method: "POST",
    json: { id: movie.id },
  });
  return row;
}

it.each([
  {
    error: new CoreError(404, "not_found"),
    lines: [
      "Movie night didn't run",
      "That automation is gone. It may have been deleted elsewhere.",
    ],
  },
  {
    error: new Error("Disconnected"),
    lines: [
      "Couldn't confirm that Movie night ran",
      "Check History before running it again.",
    ],
  },
])(
  "shows the Run outcome immediately after its row ($error.message)",
  async ({ error, lines }) => {
    const row = await runMovie(error);
    expect(problemLines(alert())).toEqual(lines);
    expect(alert()?.closest("li")?.previousElementSibling).toBe(row);
  },
);

it.each([true, false])(
  "keeps the alert when its row disappears (other automations: %s)",
  async (hasOtherAutomation) => {
    const row = await runMovie(new CoreError(404, "not_found"));
    workflows = hasOtherAutomation ? [reading] : [];
    await act(async () => live.refresh());
    expect(row.isConnected).toBe(false);
    expect(problemLines(alert())[0]).toBe("Movie night didn't run");
    expect(alert()?.closest("li")).toBeNull();
  },
);
