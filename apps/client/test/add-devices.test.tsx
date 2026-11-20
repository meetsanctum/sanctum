// @vitest-environment jsdom
import type { PairingInfo } from "@meetsanctum/app-sdk";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { AddDevices } from "../src/add-devices";
import { coreJson } from "../src/core-fetch";
import {
  core,
  live,
  named,
  page,
  plug,
  root,
  show,
  way,
} from "./add-devices-support";
import { office, zigbee } from "./settings-devices-fixtures";

describe("Add devices, choosing what to add", () => {
  it("asks what you are adding, with what was found and each radio", async () => {
    await show();

    expect(page().querySelector("h3")!.textContent).toBe(
      "What are you adding?",
    );
    expect(
      [...page().querySelectorAll("li")].map((card) => card.textContent),
    ).toEqual([
      "Devices foundAlready on your Wi‑Fi2 foundStart",
      "ZigbeeLights, sensors and remotesStart",
    ]);
    // Nothing joins until a radio is chosen.
    expect(core.requests).toEqual([]);
  });

  it("offers what was found while a driver finds devices, though nothing is found yet", async () => {
    core.adding = { ...core.adding, finders: ["sanctum.example"], found: [] };
    await show();

    expect(page().querySelector("li")!.textContent).toBe(
      "Devices foundAlready on your Wi‑FiNone foundStart",
    );
    await way("Devices found");
    expect(page().textContent).toContain(
      "Nothing found yet. Check your device is switched on and connected to your Wi‑Fi.",
    );
    expect(document.querySelector("[data-slot=overlay-footer]")).toBeNull();
  });

  it("says what to plug in where the home never had a Zigbee adapter, and otherwise that nothing adds devices", async () => {
    // No app lets devices join: Zigbee waits for its adapter.
    core.adding = { ...core.adding, drivers: [], found: [] };
    const render = (notSetUp?: Parameters<typeof AddDevices>[0]["notSetUp"]) =>
      act(async () =>
        root.render(
          <AddDevices
            open
            onOpenChange={() => undefined}
            devices={[]}
            rooms={[office]}
            apps={[
              {
                ...zigbee,
                state: "waiting",
                run: {
                  since: "2026-10-29T12:00:00.000Z",
                  waitingFor: "Waiting for Zigbee2MQTT",
                  ownWait: true,
                },
              },
            ]}
            adding={core.adding}
            notSetUp={notSetUp}
            live={live}
            onChanged={() => {}}
          />,
        ),
      );

    await render([
      {
        service: "zigbee2mqtt",
        problem: "No Zigbee coordinator is plugged in",
        apps: ["sanctum.zigbee"],
      },
    ]);
    // Its card stays in place, dimmed, saying what to plug in.
    const card = page().querySelector("button")!;
    expect(card.textContent).toBe(
      "ZigbeePlug in a Zigbee adapter to add Zigbee devices.Not set upStart",
    );
    expect(card.disabled).toBe(true);
    expect(page().querySelector("[role=alert]")).toBeNull();

    await render();
    expect(page().querySelector("[role=alert]")?.textContent).toBe(
      "No app that adds devices is running.",
    );
    expect(page().textContent).not.toContain("Plug in a Zigbee adapter");
  });

  it.each(["off", "paused", "failed", "stopped", "waiting"] as const)(
    "does not suggest an adapter when the app is %s for a reason of the core's",
    async (state) => {
      core.adding = { ...core.adding, drivers: [], found: [] };
      await act(async () =>
        root.render(
          <AddDevices
            open
            onOpenChange={() => undefined}
            devices={[]}
            rooms={[office]}
            apps={[
              {
                ...zigbee,
                state,
                run: {
                  since: "2026-10-29T12:00:00.000Z",
                  waitingFor: "Waiting for its data to come back",
                },
              },
            ]}
            adding={core.adding}
            notSetUp={[
              {
                service: "zigbee2mqtt",
                problem: "No Zigbee coordinator is plugged in",
                apps: [zigbee.id],
              },
            ]}
            live={live}
            onChanged={() => {}}
          />,
        ),
      );

      expect(page().querySelector("[role=alert]")?.textContent).toBe(
        "No app that adds devices is running.",
      );
      expect(page().textContent).not.toContain("Plug in a Zigbee adapter");
    },
  );

  it("offers a radio once its app starts letting devices join", async () => {
    core.adding = { ...core.adding, drivers: [] };
    await show();
    expect(page().textContent).not.toContain("Zigbee");

    await act(async () =>
      live.publish({
        type: "pairing",
        pairing: { ...core.adding, drivers: [zigbee.id] },
      }),
    );

    expect(page().textContent).toContain("ZigbeeLights, sensors and remotes");
  });

  it("offers only what was found when no app lets devices join", async () => {
    core.adding = { ...core.adding, drivers: [] };

    await show();

    expect(page().querySelectorAll("li")).toHaveLength(1);
    expect(page().querySelector("[role=alert]")).toBeNull();
  });

  it("starts each page at the top even when the previous page was scrolled", async () => {
    await show();
    const viewport = page().closest<HTMLElement>(
      "[data-slot=scroll-area-viewport]",
    )!;

    viewport.scrollTop = 100;
    await way("Devices found");
    expect(viewport.scrollTop).toBe(0);

    viewport.scrollTop = 200;
    await act(async () => named("Back to Add devices").click());
    expect(viewport.scrollTop).toBe(0);
  });

  it("follows found devices from its own pairing updates", async () => {
    await show(undefined, false);
    await act(async () =>
      live.publish({
        type: "pairing",
        pairing: { ...core.adding, found: [plug] },
      }),
    );
    await way("Devices found");

    expect(page().textContent).not.toContain("Kitchen sensor");
    expect(page().textContent).toContain("Living room plug");
  });

  it("keeps a live update that arrives before an older read of its own", async () => {
    let finish!: (info: PairingInfo) => void;
    const answered = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation((path, init) =>
      path === "/api/devices/pairing"
        ? new Promise((done) => (finish = done as never))
        : answered(path, init),
    );
    await show(undefined, false);

    await act(async () => live.refresh());
    await act(async () =>
      live.publish({
        type: "pairing",
        pairing: { ...core.adding, found: [plug] },
      }),
    );
    await act(async () => finish({ ...core.adding, found: [] }));
    await way("Devices found");

    expect(page().textContent).toContain("Living room plug");
  });
});
