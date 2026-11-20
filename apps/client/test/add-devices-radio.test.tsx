// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  core,
  joiningDevice,
  named,
  page,
  show,
  way,
} from "./add-devices-support";

describe("Add devices, letting a radio's devices join", () => {
  it("lets a radio's devices join from its card, and stops them when its page is left", async () => {
    await show();
    await way("Zigbee");

    expect(core.requests).toContainEqual({
      path: "/api/devices/pairing/open",
      json: { seconds: 240, drivers: ["sanctum.zigbee"] },
    });
    expect(document.querySelector("[role=dialog] h2")!.textContent).toBe(
      "Zigbee",
    );
    expect(page().querySelector("h3")!.textContent).toBe(
      "4:00• left. Looking for devices…",
    );
    expect(page().querySelector("[role=status]")!.textContent).toBe(
      "Looking for devices",
    );

    await act(async () => named("Back to Add devices").click());
    expect(core.requests.at(-1)?.path).toBe("/api/devices/pairing/close");
    expect(page().querySelector("h3")!.textContent).toBe(
      "What are you adding?",
    );
  });

  it.each(["no joins", "a failed join"])(
    "gives Start again priority when time is up with %s",
    async (outcome) => {
      const hasFailedJoin = outcome === "a failed join";
      if (hasFailedJoin)
        core.adding.joined = [{ ...joiningDevice, stage: "failed" }];
      const dialog = await show();
      await way("Zigbee");

      await act(async () => vi.advanceTimersByTime(240_000));
      expect(page().querySelector("h3")!.textContent).toBe("Time's up");
      expect(page().textContent.includes("Device failed to join")).toBe(
        hasFailedJoin,
      );
      expect(page().textContent).toContain(
        "Zigbee devices can't join right now. Start again to give them another 4 minutes.",
      );

      const buttons = [...dialog.querySelectorAll("button")];
      const again = buttons.find(
        (button) => button.textContent === "Start again",
      )!;
      const done = buttons.find((button) => button.textContent === "Done")!;
      expect(again.dataset.variant).toBe("default");
      expect(done.dataset.variant).toBe("outline");
      await act(async () => again.click());
      expect(
        core.requests.filter(
          (each) => each.path === "/api/devices/pairing/open",
        ),
      ).toHaveLength(2);
    },
  );
});
