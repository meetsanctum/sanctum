// @vitest-environment jsdom
import type { JoinedDevice } from "@meetsanctum/app-sdk";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { CoreError, coreJson } from "../src/core-fetch";
import { light } from "./settings-devices-fixtures";
import {
  admin,
  button,
  choose,
  devices,
  live,
  pairing,
  requests,
  setDevices,
  setPairing,
  show,
  type,
} from "./settings-devices-harness";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

describe("Settings → Add devices", () => {
  // Chooses a way to add devices on Add devices' first page, by its name.
  async function way(name: string) {
    const card = [
      ...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button"),
    ].find((candidate) => candidate.textContent?.startsWith(name));
    await act(async () => card!.click());
  }

  it("opens on what you are adding, and lets devices join no radio until one is chosen", async () => {
    await show(admin);
    await act(async () => button("Add devices").click());
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;

    expect(dialog.querySelector("h3")?.textContent).toBe(
      "What are you adding?",
    );
    expect(
      requests.filter((each) => each.path.startsWith("/api/devices/pairing/")),
    ).toEqual([]);
    // Done closes without stopping what nothing started.
    await act(async () => button("Done").click());
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(
      requests.filter((each) => each.path.startsWith("/api/devices/pairing/")),
    ).toEqual([]);
  });

  it("says when Done cannot stop pairing, then closes anyway", async () => {
    await show(admin);
    await act(async () => button("Add devices").click());
    await way("Zigbee");
    vi.mocked(coreJson).mockRejectedValueOnce(new CoreError(500, "app_failed"));
    await act(async () => button("Done").click());
    const alert = document.querySelector("[role=dialog] [role=alert]")!;
    expect([...alert.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      "Looking didn't stop",
      "Devices can still join until the time is up.",
    ]);
    expect(pairing.until).not.toBeNull();

    // Never stuck: the network closes by itself, and leaving tries once more.
    await act(async () => button("Close anyway").click());
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(pairing.until).toBeNull();
  });

  it("lets devices join the chosen radio, and names each as it is ready", async () => {
    await show(admin);
    await act(async () => button("Add devices").click());
    await way("Zigbee");
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;

    expect(requests).toContainEqual({
      path: "/api/devices/pairing/open",
      json: { seconds: 240, drivers: ["sanctum.zigbee"] },
    });
    // The radio by its app's name, with the time left, calm until one joins.
    expect(dialog.querySelector("h3")?.textContent).toBe(
      "4:00• left. Looking for devices…",
    );
    expect(dialog.textContent).toContain(
      "Zigbee devices can join for 4 minutes. When the time is up, you can start again.",
    );
    await act(async () => vi.advanceTimersByTime(8_000));
    expect(dialog.querySelector("h3")?.textContent).toContain("3:52");

    const joining: JoinedDevice = {
      driver: "sanctum.zigbee",
      key: "0x0017880102b3c4d5",
      stage: "interviewing",
      description: null,
      deviceId: null,
      known: false,
      joinedAt: "2026-10-29T12:00:05.000Z",
    };
    // One that joined before this overlay let devices join is not this one's.
    const earlier = {
      ...joining,
      key: "0x2",
      joinedAt: "2026-10-29T11:30:00Z",
    };
    await act(async () =>
      live.publish({
        type: "pairing",
        pairing: { ...pairing, joined: [earlier, joining] },
      }),
    );
    const cards = () => [
      ...dialog.querySelectorAll('[aria-label="Devices that joined"] > li'),
    ];
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.textContent).toBe("New deviceSetting up…");
    const firstCard = cards()[0] as HTMLLIElement;
    expect(firstCard.style.getPropertyValue("--card-wait")).toBe("450ms");
    // Once one joins, the line under the heading has done its job: only a
    // copy hidden from assistive technology stays while it fades out.
    const waitingLines = [...dialog.querySelectorAll("p")].filter((line) =>
      line.textContent.includes("can join for 4 minutes"),
    );
    expect(waitingLines).toHaveLength(1);
    expect(waitingLines[0]!.getAttribute("aria-hidden")).toBe("true");

    const added = light("bulb", "Light 2");
    // Two that come together after the move rise in at once, neither
    // waiting for the other.
    const later = { ...joining, key: "0x3" };
    const alsoLater = { ...joining, key: "0x4" };
    setDevices([...devices, added]);
    await act(async () => {
      live.publish({ type: "device", id: "bulb", device: added });
      // The core keeps what joined, so its later answers say so too.
      setPairing({
        ...pairing,
        joined: [
          {
            ...joining,
            stage: "ready",
            deviceId: "bulb",
            description: "Hue Essential White and Color Ambiance A60",
          },
          later,
          alsoLater,
        ],
      });
      live.publish({ type: "pairing", pairing });
    });
    const name = dialog.querySelector<HTMLInputElement>(
      'input[aria-label="Name for Hue Essential White and Color Ambiance A60"]',
    )!;
    expect(name.value).toBe("Light 2");
    expect(cards()[0]).toBe(firstCard);
    expect(firstCard.querySelector('[aria-label="Ready"]')).not.toBeNull();
    const laterCard = cards()[1] as HTMLLIElement;
    expect(laterCard.style.getPropertyValue("--card-wait")).toBe("0ms");
    expect(laterCard.style.getPropertyValue("--card-stagger")).toBe("0ms");
    const alsoLaterCard = cards()[2] as HTMLLIElement;
    expect(alsoLaterCard.style.getPropertyValue("--card-wait")).toBe("0ms");
    expect(alsoLaterCard.style.getPropertyValue("--card-stagger")).toBe("0ms");

    await type(name, "Desk lamp");
    await act(async () =>
      name.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
    );
    // Saved, it goes by its new name.
    await choose("Desk lamp: room", "Office");
    expect(requests).toContainEqual({
      path: "/api/devices/update",
      json: { id: "bulb", name: "Desk lamp" },
    });
    expect(requests).toContainEqual({
      path: "/api/devices/update",
      json: { id: "bulb", roomId: "office" },
    });

    // With a device ready, Done leads while it still looks, beside an
    // outlined Stop looking.
    expect(button("Done").dataset.variant).toBe("default");
    expect(button("Stop looking").dataset.variant).toBe("outline");
    await act(async () => button("Stop looking").click());
    expect(dialog.querySelector("h3")?.textContent).toBe("Stopped looking");
    // With devices joined, closing is what is left: Done leads, and starting
    // again is outlined.
    expect(button("Done").dataset.variant).toBe("default");
    expect(button("Start again").dataset.variant).toBe("outline");
    await act(async () => button("Done").click());
    expect(
      requests.filter((each) => each.path === "/api/devices/pairing/close"),
    ).toHaveLength(1);
  });

  it("stops devices joining when going back to the choice", async () => {
    await show(admin);
    await act(async () => button("Add devices").click());
    await way("Zigbee");

    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[role=dialog] button[aria-label="Back to Add devices"]',
        )!
        .click(),
    );

    expect(document.querySelector("[role=dialog] h3")?.textContent).toBe(
      "What are you adding?",
    );
    expect(
      requests.filter((each) => each.path === "/api/devices/pairing/close"),
    ).toHaveLength(1);
  });

  it("names a device the home has while it is set up again", async () => {
    await show(admin);
    await act(async () => button("Add devices").click());
    await way("Zigbee");
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;

    await act(async () =>
      live.publish({
        type: "pairing",
        pairing: {
          ...pairing,
          joined: [
            {
              driver: "sanctum.zigbee",
              key: "0x0017880102b3c4d5",
              stage: "interviewing",
              description: "Hue Essential White and Color Ambiance A60",
              deviceId: "desk",
              known: true,
              joinedAt: "2026-10-29T12:00:05.000Z",
            },
          ],
        },
      }),
    );

    expect(
      dialog.querySelector('[aria-label="Devices that joined"] > li')!
        .textContent,
    ).toBe("LightSetting up…");
  });

  it("says when the radio can't let devices join", async () => {
    await show(admin);
    await act(async () => button("Add devices").click());
    vi.mocked(coreJson).mockImplementationOnce(async () => {
      throw new CoreError(503, "unavailable");
    });

    await way("Zigbee");

    expect(
      document.querySelector("[role=dialog] [role=alert]")!.textContent,
    ).toBe("Zigbee isn't running, so its devices can't join now.");
    expect(document.querySelector("[role=dialog] h3")?.textContent).toBe(
      "Couldn't start looking",
    );
    expect(button("Try again")).toBeDefined();
  });
});
