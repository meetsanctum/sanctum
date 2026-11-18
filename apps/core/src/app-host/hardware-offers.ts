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
  available: Pick<AvailableApps, "list">;
  manager: { zigbeeSticks?(): Promise<Stick[]> };
  // Clients hear of the offer as it changes.
  onOffer?: (offer: HardwareOffer | null) => void;
  now?: () => Date;
  log: (message: string) => void;
  everyMs?: number;
}) {
  const { db, log } = options;
  const now = options.now ?? (() => new Date());
  let offer: HardwareOffer | null = null;
  let timer: NodeJS.Timeout | undefined;
  let looking: Promise<void> | undefined;

  const seenPaths = () =>
    new Set(
      db
        .select({ path: sticksSeen.path })
        .from(sticksSeen)
        .all()
        .map((row) => row.path),
    );

  function markSeen(paths: readonly string[]) {
    if (paths.length === 0) return;
    const at = now();
    durably(db, () => {
      for (const path of paths) {
        db.insert(sticksSeen)
          .values({ path, seenAt: at })
          .onConflictDoNothing()
          .run();
      }
    });
  }

  function set(next: HardwareOffer | null) {
    offer = next;
    options.onOffer?.(next);
  }

  // The app the home could add for a Zigbee stick: none once it has one,
  // since Add apps lists only those it hasn't.
  async function appForSticks() {
    const apps = await options.available.list();
    return (
      apps.find((app) =>
        app.requests.some((request) => request.id === zigbeeService),
      ) ?? null
    );
  }

  async function look() {
    const lister = options.manager.zigbeeSticks;
    if (!lister) return;
    let sticks: Stick[];
    try {
      sticks = await lister();
    } catch {
      // A manager that can't see the host's devices, or doesn't answer,
      // changes nothing: the next look tries again.
      return;
    }
    const present = new Set(sticks.map((stick) => stick.path));
    const seen = seenPaths();
    // Unplugged, so plugging it in again asks again.
    const gone = [...seen].filter((path) => !present.has(path));
    if (gone.length > 0) {
      durably(db, () => {
        db.delete(sticksSeen).where(inArray(sticksSeen.path, gone)).run();
      });
    }
    // Someone added it, here or on another client: it ends everywhere.
    if (offer && options.added.ids().has(offer.app)) {
      markSeen(offer.sticks.map((stick) => stick.path));
      set(null);
      return;
    }
    const still = offer?.sticks.filter((stick) => present.has(stick.path));
    const fresh = sticks.filter(
      (stick) =>
        !seen.has(stick.path) &&
        !still?.some((each) => each.path === stick.path),
    );
    if (fresh.length === 0) {
      // Unplugged before anyone answered.
      if (offer && still?.length === 0) set(null);
      else if (offer && still!.length < offer.sticks.length) {
        set({ ...offer, sticks: still! });
      }
      return;
    }
    // Only a stick that's new asks what the home could add, which takes the
    // manager a moment.
    const app = await appForSticks();
    if (!app) {
      // The home has an app for them, or none to offer: nothing asks.
      markSeen(fresh.map((stick) => stick.path));
      return;
    }
    const next = [...(still ?? []), ...fresh];
    log(`apps: ${next.map((stick) => stick.label).join(", ")} plugged in`);
    set({ id: offer?.id ?? randomUUID(), app: app.id, sticks: next });
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

    /** Looks for sticks plugged in or unplugged now, as after an add. */
    look: lookNow,

    /**
     * Someone said no, on any client: it ends everywhere, and the sticks it
     * named ask nothing more while they stay plugged in. An offer that has
     * ended is a conflict.
     */
    async dismiss(principal: Principal, id: string) {
      options.gate.admit(principal, permissionsRule);
      await looking;
      if (offer?.id !== id) throw new ActionCallError("conflict");
      markSeen(offer.sticks.map((stick) => stick.path));
      set(null);
    },

    /** Looks at once, then every few seconds, as a step of starting. */
    start() {
      void lookNow();
      timer = setInterval(() => void lookNow(), options.everyMs ?? lookEveryMs);
      timer.unref();
    },

    async close() {
      clearInterval(timer);
      timer = undefined;
      await looking;
    },
  };
}

export type HardwareOffers = ReturnType<typeof createHardwareOffers>;
