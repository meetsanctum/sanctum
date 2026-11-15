// @vitest-environment jsdom
import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { DeviceDetail } from "../src/device-detail";
import { useDevices } from "../src/use-devices";
import { unknownHome } from "./home-fixtures";
import { contactSensor, places, sensor } from "./place-pages-fixtures";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
let live: ReturnType<typeof createLiveFeed>;
let device: DeviceInfo;

function Detail(props: { capability: string }) {
  const devices = useDevices(live);
  return (
    <DeviceDetail
      container={container}
      tileKey={`${device.id}/${props.capability}`}
      open
      devices={devices}
      apps={[]}
      live={live}
      home={unknownHome}
      onClose={() => {}}
      onCovering={() => {}}
      onShowActivity={() => {}}
      onOpenAppSettings={() => {}}
      onOpenStatus={() => {}}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  live = createLiveFeed();
  const contact = contactSensor("sensor", "Hall sensor", "hall", false);
  device = {
    ...contact,
    capabilities: [
      ...contact.capabilities,
      ...sensor("sensor", "hall", 21, 48).capabilities,
    ],
  };
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path === "/api/devices") return [device];
    if (path === "/api/places") return places;
    if (path.startsWith("/api/activity?")) return { entries: [], more: false };
    if (path.startsWith("/api/history/")) {
      const query = new URL(path, "http://core").searchParams;
      return {
        device: device.id,
        capability: query.get("capability"),
        kind: query.get("capability") === "contact" ? "contact" : "sensor",
        from: query.get("from"),
        to: query.get("to"),
        kept: false,
        states: [],
        period: query.get("period"),
        fields: {},
      };
    }
    throw new Error(`Unexpected ${path}`);
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

describe("a contact sensor's detail navigation", () => {
  it.each([
    ["door", "Door", "door-closed"],
    ["window", "Window", "window-closed"],
    [null, "Contact", "contact-closed"],
  ] as const)(
    "uses the device's choice (%s) from its contact and readings tiles",
    async (shownAs, label, glyph) => {
      device = { ...device, type: shownAs ?? "contact", shownAs };
      for (const capability of ["contact", "temperature"]) {
        await act(async () => root.render(<Detail capability={capability} />));
        await act(async () => live.refresh());

        const tabs = [...container.querySelectorAll('[role="tab"]')];
        expect(tabs.map((each) => each.getAttribute("aria-label"))).toEqual([
          label,
          "Readings",
          "Activity",
        ]);
        expect(
          tabs[0]!.querySelector("svg")?.classList.contains(`lucide-${glyph}`),
        ).toBe(true);
        expect(tabs.map((each) => each.getAttribute("aria-selected"))).toEqual(
          capability === "contact"
            ? ["true", "false", "false"]
            : ["false", "true", "false"],
        );
      }
    },
  );
});
