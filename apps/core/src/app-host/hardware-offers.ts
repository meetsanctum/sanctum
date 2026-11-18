import type { HardwareOffer } from "@meetsanctum/app-sdk";
import { inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { Principal } from "../auth/clients.js";
import { durably, type CoreDatabase } from "../database.js";
import type { AddedApps } from "./added.js";
import type { AvailableApps } from "./available.js";
import { ActionCallError } from "./errors.js";
import type { Gate } from "./gate.js";
import { permissionsRule } from "./grants.js";
import { sticksSeen } from "./schema.js";

// A Zigbee stick plugged in while the home has no app for it brings up that
// app's add sheet, so whoever plugged it in sees what it needs before it runs:
// the app the home could add that asks for Zigbee2MQTT. Nothing is added in the
// background. It asks once per plugging in, on every client open and the next
// one opened, and ends everywhere once someone adds the app or says no, or the
// stick is unplugged; plugging it in again asks again. The core looks every few
// seconds, as the manager sees the host's devices. A stick it saw before, as
// after a restart or a power cut, asks nothing (sticksSeen), so a home that
// chose not to add the app isn't asked at every start, and one plugged in
// while the home was off asks once it's back. Several sticks plugged in
// together share one offer.

const zigbeeService = "services:zigbee2mqtt";
const lookEveryMs = 3_000;

type Stick = { path: string; label: string };

export function createHardwareOffers(options: {
  db: CoreDatabase;
  gate: Pick<Gate, "admit">;
  added: Pick<AddedApps, "ids">;
  available: Pick<AvailableApps, "findWithPermission">;
  manager: { zigbeeSticks?(): Promise<Stick[]> };
  hasInstalled: () => boolean;
  // Clients hear of the offer as it changes.
  onOffer?: (offer: HardwareOffer | null) => void;
  now?: () => Date;
  log: (message: string) => void;
}) {
  const { db, log } = options;
  const now = options.now ?? (() => new Date());
  let offer: HardwareOffer | null = null;
  let timer: NodeJS.Timeout | undefined;
  let looking: Promise<void> | undefined;
  let isStopping = false;

  const seenPaths = () =>
    new Set(
      db
        .select({ path: sticksSeen.path })
        .from(sticksSeen)
        .all()
        .map((row) => row.path),
    );

  function recordSeen(sticks: readonly Stick[]) {
    const at = now();
    for (const { path } of sticks) {
      db.insert(sticksSeen)
        .values({ path, seenAt: at })
        .onConflictDoNothing()
        .run();
    }
  }

  function markSeen(sticks: readonly Stick[]) {
    if (sticks.length > 0) durably(db, () => recordSeen(sticks));
  }

  function set(next: HardwareOffer | null) {
    offer = next;
    options.onOffer?.(next);
  }

  async function look() {
    if (isStopping || !options.hasInstalled() || !options.manager.zigbeeSticks)
      return;
    let sticks: Stick[];
    try {
      sticks = await options.manager.zigbeeSticks();
    } catch {
      // A manager that can't see the host's devices, or doesn't answer,
      // changes nothing: the next look tries again.
      return;
    }
    if (isStopping) return;
    const present = new Set(sticks.map((stick) => stick.path));
    const seen = seenPaths();
    // Unplugged, so plugging it in again asks again.
    const gone = [...seen].filter((path) => !present.has(path));
    if (gone.length > 0) {
      durably(db, () => {
        db.delete(sticksSeen).where(inArray(sticksSeen.path, gone)).run();
      });
    }
    const still =
      offer?.sticks.filter((stick) => present.has(stick.path)) ?? [];
    const fresh = sticks.filter(
      (stick) =>
        !seen.has(stick.path) &&
        !still.some((each) => each.path === stick.path),
    );
    if (offer && still.length > 0) {
      if (fresh.length > 0 || still.length !== offer.sticks.length) {
        set({ ...offer, sticks: [...still, ...fresh] });
      }
      return;
    }
    // A set of sticks with no overlap is a new offer. End the old one
    // before asking what the home could add.
    if (offer) set(null);
    if (fresh.length === 0) return;
    const app = await options.available.findWithPermission(zigbeeService);
    if (isStopping || app === undefined) return;
    if (!app || options.added.ids().has(app.id)) {
      // The home has an app for them, or none to offer: nothing asks.
      markSeen(fresh);
      return;
    }
    // A stick unplugged while that was read offers nothing; one the
    // manager can't say about now waits for the next look.
    const now = await options.manager.zigbeeSticks().catch(() => undefined);
    if (isStopping || !now) return;
    const plugged = fresh.filter((stick) =>
      now.some((each) => each.path === stick.path),
    );
    if (plugged.length === 0) return;
    log(`apps: ${plugged.map((stick) => stick.label).join(", ")} plugged in`);
    set({ id: randomUUID(), app: app.id, sticks: plugged });
  }

  // One look at a time: the manager may take a while to answer.
  function lookNow() {
    looking ??= look()
      .catch((error: unknown) => {
        log(`apps: the sticks weren't looked at (${String(error)})`);
      })
      .finally(() => {
        looking = undefined;
      });
    return looking;
  }

  return {
    /** The offer every client shows, if any. */
    current: () => offer,

    /** Looks for sticks plugged in or unplugged now. */
    look: lookNow,

    matches(appId: string, offerId: string) {
      return offer?.app === appId && offer.id === offerId;
    },

    /** Records the answer within the same transaction as the app add. */
    recordAdd(appId: string) {
      if (offer?.app === appId) recordSeen(offer.sticks);
    },

    /** Publishes the end once the add has committed. */
    finishAdd(appId: string) {
      if (offer?.app === appId) set(null);
    },

    /**
     * Someone said no, on any client: it ends everywhere, and the sticks it
     * named ask nothing more while they stay plugged in. An offer that has
     * ended is a conflict.
     */
    async dismiss(principal: Principal, id: string) {
      options.gate.admit(principal, permissionsRule);
      if (offer?.id !== id) throw new ActionCallError("conflict");
      markSeen(offer.sticks);
      set(null);
    },

    /** Looks at once, then every few seconds, as a step of starting. */
    start() {
      void lookNow();
      timer = setInterval(() => void lookNow(), lookEveryMs);
      timer.unref();
    },

    interrupt() {
      isStopping = true;
      clearInterval(timer);
    },

    async close() {
      await looking;
    },
  };
}

export type HardwareOffers = ReturnType<typeof createHardwareOffers>;
