// @vitest-environment jsdom
import type { DeviceInfo, PairingInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AddDevices } from "../src/add-devices";
import { CoreError, coreJson } from "../src/core-fetch";
import { light, office, zigbee } from "./settings-devices-fixtures";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

function pendingReply<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe("Add devices navigation while requests finish", () => {
  let root: Root;
  let container: HTMLDivElement;
  let pairing: PairingInfo;
  let requests: string[];
  const live = createLiveFeed();
  const changed = vi.fn();
  const onOpenChange = vi.fn();
  const added = light("sensor", "Kitchen sensor");

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
    pairing = {
      until: null,
      joined: [],
      drivers: [zigbee.id],
      finders: [zigbee.id],
      offers: [],
      found: [
        {
          driver: zigbee.id,
          key: "sensor",
          name: "Kitchen sensor",
          description: null,
          type: null,
          asks: [],
          later: [],
          refusals: {},
        },
      ],
    };
    requests = [];
    changed.mockReset();
    onOpenChange.mockReset();
    vi.mocked(coreJson).mockReset();
    vi.mocked(coreJson).mockImplementation(async (path) => {
      requests.push(path);
      if (path === "/api/devices/pairing/open") {
        pairing = { ...pairing, until: "2026-10-29T12:04:00.000Z" };
        return { ...pairing, since: "2026-10-29T12:00:00.000Z" };
      }
      if (path === "/api/devices/pairing/close") {
        pairing = { ...pairing, until: null };
      }
      return pairing;
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const show = (open = true, hasPairing = true) =>
    act(async () =>
      root.render(
        <AddDevices
          open={open}
          onOpenChange={onOpenChange}
          devices={[]}
          rooms={[office]}
          apps={[zigbee]}
          adding={hasPairing ? pairing : undefined}
          live={live}
          onChanged={changed}
        />,
      ),
    );

  const dialog = () => document.querySelector<HTMLElement>("[role=dialog]")!;
  const button = (name: string) =>
    [...dialog().querySelectorAll("button")].find(
      (each) =>
        each.getAttribute("aria-label") === name ||
        each.textContent?.startsWith(name),
    )!;
  const click = (name: string) => act(async () => button(name).click());
  const closes = () =>
    requests.filter((path) => path === "/api/devices/pairing/close");

  it("waits for the radio to stop before returning to the choice", async () => {
    await show();
    await click("Zigbee");
    const reply = pendingReply<PairingInfo>();
    vi.mocked(coreJson).mockReturnValueOnce(reply.promise);
    await click("Back to Add devices");

    expect(dialog().querySelector("h2")!.textContent).toBe("Zigbee");
    await act(async () => reply.resolve({ ...pairing, until: null }));
    expect(dialog().querySelector("h2")!.textContent).toBe("Add devices");
  });

  it.each(["Back to Add devices", "Stop looking"])(
    "reports a failed stop from %s and lets the user retry",
    async (control) => {
      await show();
      await click("Zigbee");
      vi.mocked(coreJson).mockRejectedValueOnce(
        new CoreError(500, "app_failed"),
      );
      await click(control);

      expect(dialog().querySelector("h2")!.textContent).toBe("Zigbee");
      expect(dialog().querySelector("h3")!.textContent).toContain(
        "Looking for devices",
      );
      const alert = dialog().querySelector("[role=alert]")!;
      expect(
        [
          ...alert.querySelectorAll(
            "[data-slot=alert-title], [data-slot=alert-description]",
          ),
        ].map((line) => line.textContent),
      ).toEqual([
        "Looking didn't stop",
        "Sanctum ran into a problem. Try again in a moment.",
      ]);
      expect(pairing.until).not.toBeNull();

      await click(control);
      expect(pairing.until).toBeNull();
      expect(dialog().querySelector("[role=alert]")).toBeNull();
      if (control === "Back to Add devices") {
        expect(dialog().querySelector("h2")!.textContent).toBe("Add devices");
      } else {
        expect(dialog().querySelector("h3")!.textContent).toBe(
          "Stopped looking",
        );
      }
    },
  );

  it("stops a reopened radio after an earlier overlay's close finishes late", async () => {
    await show();
    await click("Zigbee");
    const reply = pendingReply<PairingInfo>();
    vi.mocked(coreJson).mockReturnValueOnce(reply.promise);
    await show(false);
    await show();
    await click("Zigbee");
    await act(async () => reply.resolve({ ...pairing, until: null }));
    await click("Done");

    expect(closes()).toHaveLength(1);
    expect(pairing.until).toBeNull();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("lets a retried start expire after an earlier stop finishes", async () => {
    await show();
    pairing = { ...pairing, until: "2026-10-29T12:02:00.000Z" };
    await act(async () => live.publish({ type: "pairing", pairing }));
    vi.mocked(coreJson).mockRejectedValueOnce(new CoreError(500, "app_failed"));
    await click("Zigbee");

    const reply = pendingReply<PairingInfo>();
    vi.mocked(coreJson).mockReturnValueOnce(reply.promise);
    await click("Stop looking");
    await click("Try again");
    await act(async () => reply.resolve({ ...pairing, until: null }));

    expect(dialog().querySelector("h3")!.textContent).toContain("4:00");
    await act(async () => vi.advanceTimersByTime(240_000));
    expect(dialog().querySelector("h3")!.textContent).toBe("Time's up");
  });

  it("finishes an earlier pairing open and close before reopening", async () => {
    const reply = pendingReply<PairingInfo & { since: string }>();
    vi.mocked(coreJson).mockReturnValueOnce(reply.promise);
    await show();
    await click("Zigbee");
    await show(false);
    await show();
    await click("Zigbee");
    await act(async () =>
      reply.resolve({
        ...pairing,
        until: "2026-10-29T12:04:00.000Z",
        since: "2026-10-29T12:00:00.000Z",
      }),
    );
    expect(requests).toEqual([
      "/api/devices/pairing/close",
      "/api/devices/pairing/open",
    ]);
    expect(pairing.until).not.toBeNull();
  });

  it("deducts the time spent waiting for the radio from the countdown", async () => {
    await show();
    const reply = pendingReply<PairingInfo & { since: string }>();
    vi.mocked(coreJson).mockReturnValueOnce(reply.promise);
    await click("Zigbee");
    await act(async () => vi.advanceTimersByTime(3_000));
    await act(async () =>
      reply.resolve({
        ...pairing,
        until: "2026-10-29T12:04:00.000Z",
        since: "2026-10-29T12:00:00.000Z",
      }),
    );
    expect(dialog().querySelector("h3")!.textContent).toContain("3:57");
  });

  it("requires another stop after restarting following a failed dismissal", async () => {
    await show();
    await click("Zigbee");
    vi.mocked(coreJson).mockRejectedValueOnce(new CoreError(500, "app_failed"));
    await click("Done");
    await click("Stop looking");
    await click("Start again");
    await click("Done");

    expect(closes()).toHaveLength(2);
    expect(pairing.until).toBeNull();
  });

  it("waits for a restart after the countdown expires before enabling another", async () => {
    await show();
    await click("Zigbee");
    await act(async () => vi.advanceTimersByTime(240_000));
    const reply = pendingReply<PairingInfo & { since: string }>();
    vi.mocked(coreJson).mockReturnValueOnce(reply.promise);
    await click("Start again");

    expect(dialog().querySelector("h3")!.textContent).toBe("Getting ready…");
    expect(button("Stop looking").disabled).toBe(true);
    await act(async () =>
      reply.resolve({
        ...pairing,
        until: "2026-10-29T12:08:00.000Z",
        since: "2026-10-29T12:04:00.000Z",
      }),
    );
    expect(button("Stop looking").disabled).toBe(false);
  });

  it.each([false, true])(
    "keeps a found add across Back (return before completion: %s)",
    async (returnsEarly) => {
      const reply = pendingReply<{ added: DeviceInfo }>();
      await show();
      await click("Devices found");
      vi.mocked(coreJson).mockReturnValueOnce(reply.promise);
      await click("Add Kitchen sensor");
      await click("Back to Add devices");

      // Registration can remove it from discovery before the add answers.
      pairing = { ...pairing, found: [] };
      await act(async () => live.publish({ type: "pairing", pairing }));
      if (returnsEarly) {
        await click("Devices found");
        expect(button("Add Kitchen sensor").disabled).toBe(true);
      }
      await act(async () => reply.resolve({ added }));
      if (!returnsEarly) await click("Devices found");

      expect(changed).toHaveBeenCalledWith(added);
      expect(dialog().querySelector('[aria-label="Added"]')).not.toBeNull();
      expect(
        dialog().querySelector(
          'input[aria-label="Name for Hue Essential White and Color Ambiance A60"]',
        ),
      ).not.toBeNull();
    },
  );

  it("offers no radio until its driver is known", async () => {
    await show(true, false);
    expect(
      dialog().querySelector("[data-slot=overlay-content] button"),
    ).toBeNull();
    expect(requests).toEqual([]);

    await act(async () => live.publish({ type: "pairing", pairing }));
    await click("Zigbee");
    expect(vi.mocked(coreJson)).toHaveBeenCalledWith(
      "/api/devices/pairing/open",
      { method: "POST", json: { seconds: 240, drivers: [zigbee.id] } },
    );
  });

  it.each(["open", "close"])(
    "keeps a live device update ahead of a delayed %s response",
    async (operation) => {
      await show();
      if (operation === "close") await click("Zigbee");
      const snapshot = {
        ...pairing,
        until: operation === "open" ? "2026-10-29T12:04:00.000Z" : null,
        since: "2026-10-29T12:00:00.000Z",
      };
      const reply = pendingReply<typeof snapshot>();
      vi.mocked(coreJson).mockReturnValueOnce(reply.promise);
      await click(operation === "open" ? "Zigbee" : "Stop looking");
      await act(async () =>
        live.publish({
          type: "pairing",
          pairing: {
            ...snapshot,
            joined: [
              {
                driver: zigbee.id,
                key: "new-light",
                stage: "interviewing",
                description: "New light",
                deviceId: null,
                known: false,
                joinedAt: "2026-10-29T12:00:01.000Z",
              },
            ],
          },
        }),
      );
      await act(async () => reply.resolve(snapshot));

      expect(
        dialog().querySelector('[aria-label="Devices that joined"]')
          ?.textContent,
      ).toContain("New lightSetting up…");
    },
  );

  it.each([false, true])(
    "keeps an open ahead of a read made while preparing (read answers first: %s)",
    async (doesReadFinishFirst) => {
      await show();
      const before = pairing;
      const opened = {
        ...pairing,
        until: "2026-10-29T12:04:00.000Z",
        since: "2026-10-29T12:00:00.000Z",
      };
      const openReply = pendingReply<typeof opened>();
      const readReply = pendingReply<PairingInfo>();
      vi.mocked(coreJson).mockReturnValueOnce(openReply.promise);
      await click("Zigbee");
      vi.mocked(coreJson).mockReturnValueOnce(readReply.promise);
      await act(async () => live.refresh());
      if (doesReadFinishFirst) await act(async () => readReply.resolve(before));
      await act(async () => openReply.resolve(opened));
      if (!doesReadFinishFirst)
        await act(async () => readReply.resolve(before));

      expect(dialog().querySelector("h3")!.textContent).toContain(
        "Looking for devices…",
      );
    },
  );
});
