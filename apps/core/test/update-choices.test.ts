import { describe, expect, it } from "vitest";

import type { InstalledApp } from "../src/app-host/installed.js";
import type { ApartPackage } from "../src/app-host/loader.js";
import { createAppUpdateChoices } from "../src/app-host/update-choices.js";
import type { AppUpdates } from "../src/app-host/updates.js";
import type { WaitingUpdates } from "../src/app-host/waiting.js";

// Going back and allowing an update take turns for an app: a Go back whose
// package read ends just as an approval commits can't also replace the app.

const appId = "sanctum.example";

describe("going back and allowing an update", () => {
  it("take turns, so only one replaces the app", async () => {
    const entry = {
      app: { id: appId },
      apartIn: "1.0.0+test",
      supervision: { isEnded: false },
    } as unknown as InstalledApp;
    const installed = new Map([[appId, entry]]);
    const swaps: string[] = [];
    // A replacement takes the entry out at once, as apart-starts.ts does.
    const swapTo = (_: InstalledApp, to: string | ApartPackage) => {
      installed.delete(appId);
      swaps.push(typeof to === "string" ? to : to.apart.folder);
    };
    let readEnds!: () => void;
    const read = new Promise<void>((resolve) => (readEnds = resolve));
    // Go back's package read, which ends when the approval commits, or soon.
    setTimeout(() => readEnds(), 20);
    const updates = {
      shownFor: () => undefined,
      swapTo,
      async startGoingBack(current: InstalledApp) {
        await read;
        if (installed.get(appId) !== current) return false;
        swapTo(current, "0.9.0+kept");
        return true;
      },
    } as unknown as AppUpdates;
    const waiting = {
      of: () => undefined,
      forget: () => undefined,
      async allow(
        _appId: string,
        _id: string,
        when: { canAllow: () => boolean; alongside: () => void },
      ) {
        if (!when.canAllow()) return undefined;
        when.alongside();
        // The read ends in the moment between the commit and the swap.
        readEnds();
        return { apart: { folder: "2.0.0+test" } } as ApartPackage;
      },
    } as unknown as WaitingUpdates;
    const choices = createAppUpdateChoices({
      installed,
      updates,
      waiting,
      announce: () => undefined,
      log: () => undefined,
    });

    const [goingBack, allowing] = await Promise.all([
      choices.onGoBack(entry, "copy-1"),
      choices.onAllowUpdate(entry, "waiting-1", () => undefined),
    ]);

    expect(swaps).toHaveLength(1);
    expect([goingBack, allowing]).toEqual([true, false]);
  });
});
