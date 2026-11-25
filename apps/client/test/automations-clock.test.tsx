// @vitest-environment jsdom
import { createLiveFeed, HomeTimeZoneProvider } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { AutomationsPage } from "../src/automations/page";
import { coreJson } from "../src/core-fetch";
import type { useDevices } from "../src/use-devices";
import { pieces, places, workflow } from "./automations-fixtures";

vi.mock("../src/core-fetch", async (original) => ({
  ...(await original()),
  coreJson: vi.fn(),
}));

it("writes the schedule card and automatic name in the home's hour format", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const scheduled = workflow({
    id: "scheduled",
    name: "At 2:30 PM every day",
    automaticName: true,
    graph: {
      version: 1,
      nodes: [
        { id: "t", kind: "trigger", piece: "time", config: { time: "14:30" } },
        {
          id: "s",
          kind: "step",
          piece: "lights",
          config: { place: { kind: "home" }, to: "off" },
        },
      ],
      edges: [{ from: "t", to: "s" }],
    },
  });
  const named = { ...scheduled, id: "named", automaticName: undefined };
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path === "/api/workflows") return [scheduled, named];
    if (path === "/api/workflows/pieces") return pieces;
    return [];
  });
  const live = createLiveFeed();
  const show = async (hourCycle: "12h" | "24h", id?: string) => {
    await act(async () =>
      root.render(
        <HomeTimeZoneProvider
          timeZone={places.home.timeZone}
          hourCycle={hourCycle}
        >
          <AutomationsPage
            page={id ? "automation" : "main"}
            params={id ? { id } : {}}
            open={() => {}}
            back={() => {}}
            apps={[]}
            devices={
              {
                places: { ...places, home: { ...places.home, hourCycle } },
                devices: [],
              } as unknown as ReturnType<typeof useDevices>
            }
            live={live}
            openAppSettings={() => {}}
            openStatus={() => {}}
            ask={async () => true}
          />
        </HomeTimeZoneProvider>,
      ),
    );
  };
  const texts = (selector: string) =>
    [...container.querySelectorAll(selector)].map(
      (element) => element.textContent,
    );

  try {
    await show("12h");
    expect(texts("li button span")).toContain("2:30 PM");
    expect(texts("li button span")).toContain("At 2:30 PM every day");

    await show("24h");
    expect(texts("li button span")).toContain("14:30");
    expect(texts("li button span")).toContain("At 14:30 every day");
    expect(texts("li button span")).toContain(named.name);

    await show("24h", scheduled.id);
    expect(texts("h1")).toContain("At 14:30 every day");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
