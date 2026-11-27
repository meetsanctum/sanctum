// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Power } from "lucide-react";

import { DeviceTile } from "../src/device-tile";
import type { Tile } from "../src/tiles";

const lamp: Tile = {
  key: "lamp/light",
  deviceId: "lamp",
  capabilityId: "light",
  kind: "light",
  roomId: null,
  name: "Lamp",
  status: "40%",
  on: true,
  look: "lit",
  colour: "#ffcfa3",
  dims: true,
  brightness: 40,
  disabled: false,
};

let root: Root;
let container: HTMLDivElement;
const onToggle = vi.fn();
const onDim = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onToggle.mockReset();
  onDim.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe("a tile for several lights", () => {
  it("takes the icon and the name it is given for screen readers", async () => {
    await act(async () => {
      root.render(
        <DeviceTile
          tile={{ ...lamp, name: "Lights" }}
          icon={Power}
          label="Lights in Kitchen"
          onToggle={onToggle}
          onDim={onDim}
          onOpen={() => {}}
        />,
      );
    });
    const labels = [...container.querySelectorAll("[aria-label]")].map((each) =>
      each.getAttribute("aria-label"),
    );
    expect(labels).toEqual([
      "Lights in Kitchen, 40%",
      "Lights in Kitchen",
      "Lights in Kitchen brightness",
    ]);
    expect(container.querySelector("svg.lucide-power")).not.toBeNull();
    expect(container.querySelector("svg.lucide-lightbulb")).toBeNull();
    // What it shows is its own name.
    expect(container.querySelector(".truncate.text-sm")?.textContent).toBe(
      "Lights",
    );
  });
});

it.each(["light", "switch"] as const)(
  "uses the accessible label for a standalone %s toggle",
  async (kind) => {
    await act(async () => {
      root.render(
        <DeviceTile
          tile={{ ...lamp, kind }}
          label="Desk power"
          onToggle={onToggle}
          onDim={onDim}
        />,
      );
    });
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Desk power",
    );
  },
);
