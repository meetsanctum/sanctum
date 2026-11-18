import type { AvailableApp, HardwareOffer } from "@meetsanctum/app-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import type { Gate } from "../src/app-host/gate.js";
import { createHardwareOffers } from "../src/app-host/hardware-offers.js";
import type { Principal } from "../src/auth/clients.js";
import { openCoreDatabase } from "../src/database.js";

// A Zigbee stick plugged in offers the app the home could add for it, once
// per plugging in, until someone adds it or says no, or it's unplugged.

const someone = { client: { id: "client-1" } } as Principal;
const zbt2 = {
  path: "/dev/serial/by-id/usb-Nabu_Casa_ZBT-2-if00",
  label: "Home Assistant Connect ZBT-2",
};
const conbee = {
  path: "/dev/serial/by-id/usb-dresden_elektronik_ConBee_II-if00",
  label: "ConBee II",
};
const zigbeeApp = {
  id: "sanctum.example",
  requests: [{ id: "services:zigbee2mqtt" }],
} as AvailableApp;

async function home(options: { dataDir?: string } = {}) {
  const folder =
    options.dataDir ?? (await mkdtemp(join(tmpdir(), "sanctum-offers-")));
  const open = openCoreDatabase(folder);
  onTestFinished(() => open.close());
  if (!options.dataDir) {
    onTestFinished(() => rm(folder, { recursive: true, force: true }));
  }
  const state = {
    sticks: [] as (typeof zbt2)[],
    available: [zigbeeApp],
    added: new Set<string>(),
    fails: false,
    hasInstalled: true,
    isCatalogComplete: true,
    heard: [] as (HardwareOffer | null)[],
  };
  const offers = createHardwareOffers({
    db: open.db,
    gate: { admit: () => undefined } as unknown as Gate,
    added: { ids: () => state.added },
    available: {
      findWithPermission: async (permissionId) =>
        state.available.find((app) =>
          app.requests.some(({ id }) => id === permissionId),
        ) ?? (state.isCatalogComplete ? null : undefined),
    },
    hasInstalled: () => state.hasInstalled,
    manager: {
      zigbeeSticks: async () => {
        if (state.fails) throw new Error("The manager can't see /dev");
        return state.sticks;
      },
    },
    onOffer: (offer) => void state.heard.push(offer),
    log: () => undefined,
  });
  return { folder, offers, state };
}

describe("a Zigbee stick plugged in", () => {
  it("offers the app the home could add for it, once", async () => {
    const { offers, state } = await home();
    await offers.look();
    expect(offers.current()).toBeNull();

    state.sticks = [zbt2];
    await offers.look();
    await offers.look();

    expect(offers.current()).toEqual({
      id: expect.any(String),
      app: "sanctum.example",
      sticks: [zbt2],
    });
    expect(state.heard).toHaveLength(1);
  });

  it("ends everywhere on no, and asks nothing more while it stays plugged in", async () => {
    const { offers, state } = await home();
    state.sticks = [zbt2];
    await offers.look();
    const { id } = offers.current()!;

    await offers.dismiss(someone, id);
    await offers.look();

    expect(offers.current()).toBeNull();
    expect(state.heard.at(-1)).toBeNull();
    await expect(offers.dismiss(someone, id)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("asks again once unplugged and plugged in again", async () => {
    const { offers, state } = await home();
    state.sticks = [zbt2];
    await offers.look();
    await offers.dismiss(someone, offers.current()!.id);

    state.sticks = [];
    await offers.look();
    state.sticks = [zbt2];
    await offers.look();

    expect(offers.current()?.sticks).toEqual([zbt2]);
  });

  it("ends when it's unplugged before anyone answers", async () => {
    const { offers, state } = await home();
    state.sticks = [zbt2];
    await offers.look();

    state.sticks = [];
    await offers.look();

    expect(offers.current()).toBeNull();
    expect(state.heard).toEqual([expect.anything(), null]);
  });

  it("asks nothing when the home has an app for it, or none to offer", async () => {
    const { offers, state } = await home();
    state.available = [];
    state.sticks = [zbt2];

    await offers.look();
    state.available = [zigbeeApp];
    await offers.look();

    expect(offers.current()).toBeNull();
  });

  it("shares one offer between sticks plugged in together", async () => {
    const { offers, state } = await home();
    state.sticks = [zbt2];
    await offers.look();
    const { id } = offers.current()!;

    state.sticks = [zbt2, conbee];
    await offers.look();
    state.sticks = [conbee];
    await offers.look();

    expect(offers.current()).toEqual({
      id,
      app: "sanctum.example",
      sticks: [conbee],
    });
  });

  it("replaces the offer if all its sticks are gone and others are plugged in", async () => {
    const { offers, state } = await home();
    state.sticks = [zbt2];
    await offers.look();
    const { id } = offers.current()!;

    state.sticks = [conbee];
    await offers.look();

    expect(offers.current()?.id).not.toBe(id);
    expect(offers.current()?.sticks).toEqual([conbee]);
    await expect(offers.dismiss(someone, id)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("waits for the home's app list before looking for sticks", async () => {
    const { offers, state } = await home();
    state.hasInstalled = false;
    state.available = [];
    state.sticks = [zbt2];
    await offers.look();

    state.hasInstalled = true;
    state.available = [zigbeeApp];
    await offers.look();

    expect(offers.current()?.sticks).toEqual([zbt2]);
  });

  it("tries again if the app catalog is still being staged", async () => {
    const { offers, state } = await home();
    state.available = [];
    state.isCatalogComplete = false;
    state.sticks = [zbt2];
    await offers.look();
    expect(offers.current()).toBeNull();

    state.available = [zigbeeApp];
    state.isCatalogComplete = true;
    await offers.look();

    expect(offers.current()?.sticks).toEqual([zbt2]);
  });

  it("drops an in-progress scan once shutdown starts", async () => {
    const { offers, state } = await home();
    state.sticks = [zbt2];
    const scan = offers.look();
    offers.interrupt();
    await offers.close();
    await scan;

    expect(offers.current()).toBeNull();
    expect(state.heard).toEqual([]);
  });

  it("changes nothing while the manager can't say", async () => {
    const { offers, state } = await home();
    state.sticks = [zbt2];
    await offers.look();
    state.fails = true;

    await offers.look();

    expect(offers.current()?.sticks).toEqual([zbt2]);
  });
});

describe("a stick there when Sanctum starts", () => {
  it("asks nothing if it was there when Sanctum last ran", async () => {
    const first = await home();
    first.state.sticks = [zbt2];
    await first.offers.look();
    await first.offers.dismiss(someone, first.offers.current()!.id);

    const again = await home({ dataDir: first.folder });
    again.state.sticks = [zbt2];
    await again.offers.look();

    expect(again.offers.current()).toBeNull();
  });

  it("asks again if nobody answered before Sanctum stopped", async () => {
    const first = await home();
    first.state.sticks = [zbt2];
    await first.offers.look();

    const again = await home({ dataDir: first.folder });
    again.state.sticks = [zbt2];
    await again.offers.look();

    expect(again.offers.current()?.sticks).toEqual([zbt2]);
  });

  it("asks if it was plugged in while the home was off", async () => {
    const first = await home();
    await first.offers.look();

    const again = await home({ dataDir: first.folder });
    again.state.sticks = [zbt2];
    await again.offers.look();

    expect(again.offers.current()?.sticks).toEqual([zbt2]);
  });
});
