import {
  aiAlwaysOn,
  aiAreas,
  aiAreasOnAtFirst,
  capabilityKinds,
  controlPermission,
  readPermission,
  type AiCanUse,
  type AiOfferInfo,
} from "@meetsanctum/app-sdk";
import { and, eq } from "drizzle-orm";

import type { ChangedBy, NewActivityEntry } from "../activity/activity.js";
import type { DeclaredOffer } from "../app-host/contract.js";
import { ActionCallError } from "../app-host/errors.js";
import type { CoreDatabase } from "../database.js";
import { agentAreas, agentItems } from "./schema.js";

// What AI agents can use: one list for every AI agent, the household's to
// decide. Each app offers some of its actions and the entity types it
// provides, each starting on or off; the core's own areas are permissions,
// such as `people.read`. What isn't on is refused, wherever an AI agent's
// call reaches: an app's action, what that action then reads and commands,
// and the core's own reads.
//
// The core records each answer when it first sees what it answers, as it
// does for apps' grants: an app the home adds takes its own defaults, while
// a new version of one the home has run brings what it newly offers in
// off, whatever its default. An item whose tier rises goes back off, since
// the household said yes to less. Answers outlive the app's removal, so one
// coming back keeps them, and go with its data.

/** One app's offers, as its contract keeps them. */
export type AppOffers = {
  app: string;
  offers: ReadonlyMap<string, DeclaredOffer>;
};

const tierRank = { read: 0, write: 1 } as const;
const isArea = (id: string) => aiAreas.includes(id);
const itemKey = (offer: DeclaredOffer) => `${offer.kind}:${offer.id}`;

export function createAgentsCanUse(
  db: CoreDatabase,
  options: {
    record: (entry: NewActivityEntry) => string;
    // The installed apps' offers, read on every listing.
    apps: () => readonly AppOffers[];
    // Something AI agents could use was switched off, or an update raised
    // its tier, which switches it off.
    onRevoked?: () => void;
    // One of the core's areas was switched, once the change has committed.
    onAreaChanged?: () => void;
    now?: () => Date;
  },
) {
  const now = options.now ?? (() => new Date());

  // Each area gets its answer the first time the core knows of it.
  db.insert(agentAreas)
    .values(
      aiAreas
        .filter((area) => !aiAlwaysOn.includes(area))
        .map((area) => ({
          area,
          on: aiAreasOnAtFirst.includes(area),
          updatedAt: now(),
        })),
    )
    .onConflictDoNothing()
    .run();

  function areaOn(area: string): boolean {
    if (aiAlwaysOn.includes(area)) return true;
    if (!isArea(area)) return false;
    return (
      db
        .select({ on: agentAreas.on })
        .from(agentAreas)
        .where(eq(agentAreas.area, area))
        .get()?.on === true
    );
  }

  function itemRows(appId: string) {
    return new Map(
      db
        .select()
        .from(agentItems)
        .where(eq(agentItems.appId, appId))
        .all()
        .map((row) => [row.itemId, row]),
    );
  }

  function accessOf(app: AppOffers, rows: ReturnType<typeof itemRows>) {
    const answers = new Map<string, boolean>();

    function needOn(id: string): boolean {
      // A manifest can name both an area and an offer with the same id.
      // A prerequisite must identify one permission unambiguously.
      if (isArea(id)) return !app.offers.has(id) && areaOn(id);
      return offerOn(id);
    }

    function offerOn(id: string): boolean {
      const answer = answers.get(id);
      if (answer !== undefined) return answer;
      const offer = app.offers.get(id);
      if (!offer || rows.get(itemKey(offer))?.on !== true) return false;
      // An offer is unavailable while checking its own prerequisites. A
      // cycle stays off, and shared prerequisites reuse the finished answer.
      answers.set(id, false);
      const isUsable = offer.needs.every(needOn);
      answers.set(id, isUsable);
      return isUsable;
    }

    return { needOn, offerOn };
  }

  function offerInfo(app: AppOffers, rows: ReturnType<typeof itemRows>) {
    const { needOn } = accessOf(app, rows);
    return [...app.offers.values()].map((offer): AiOfferInfo => ({
      app: app.app,
      id: offer.id,
      kind: offer.kind,
      tier: offer.tier,
      title: offer.title,
      description: offer.description,
      on: rows.get(itemKey(offer))?.on === true,
      needs: [...offer.needs],
      missing: offer.needs.filter((need) => !needOn(need)),
    }));
  }

  function offersOf(appId: string) {
    return options.apps().find((each) => each.app === appId);
  }

  return {
    /**
     * Answers each of an app's offers that has none yet, as it installs: by
     * the app's default, or off for what a new version of an app the home
     * has run newly offers. One whose tier rose goes back off.
     */
    adopt(app: AppOffers, { asUpdate }: { asUpdate: boolean }): void {
      const rows = itemRows(app.app);
      const updatedAt = now();
      let revoked = false;
      db.transaction(() => {
        for (const offer of app.offers.values()) {
          const itemId = itemKey(offer);
          const row = rows.get(itemId);
          const tier = offer.tier;
          if (!row) {
            db.insert(agentItems)
              .values({
                appId: app.app,
                itemId,
                on: !asUpdate && offer.starts === "on",
                tier,
                updatedAt,
              })
              .onConflictDoNothing()
              .run();
            continue;
          }
          if (row.tier === tier) continue;
          const rose = tierRank[tier] > tierRank[row.tier];
          if (rose && row.on) revoked = true;
          db.update(agentItems)
            .set(rose ? { tier, on: false, updatedAt } : { tier })
            .where(
              and(eq(agentItems.appId, app.app), eq(agentItems.itemId, itemId)),
            )
            .run();
        }
      });
      if (revoked) options.onRevoked?.();
    },

    areaOn,

    /** Whether AI agents may use one of an app's offers now. */
    canUse(appId: string, id: string, kind: DeclaredOffer["kind"]): boolean {
      const app = offersOf(appId);
      return app?.offers.get(id)?.kind === kind
        ? accessOf(app, itemRows(appId)).offerOn(id)
        : false;
    },

    /**
     * The capability kinds AI agents may read. Controlling a kind includes
     * reading it, as it does for apps.
     */
    readableDeviceKinds() {
      return new Set(
        capabilityKinds.filter(
          (kind) =>
            areaOn(controlPermission(kind)) || areaOn(readPermission(kind)),
        ),
      );
    },

    /** Everything AI agents can use, as Settings and apps' pages show it. */
    list(): AiCanUse {
      return {
        areas: aiAreas.map((id) => ({
          id,
          on: areaOn(id),
          always: aiAlwaysOn.includes(id),
        })),
        offers: options
          .apps()
          .flatMap((app) => offerInfo(app, itemRows(app.app))),
      };
    },

    /**
     * Switches one of the core's areas, writing the activity entry in the
     * same transaction. False, and nothing changed, when it already has that
     * answer.
     */
    setArea(area: string, on: boolean, by: ChangedBy): boolean {
      if (!isArea(area) || aiAlwaysOn.includes(area)) {
        throw new ActionCallError("invalid_request");
      }
      if (areaOn(area) === on) return false;
      db.transaction(() => {
        db.update(agentAreas)
          .set({ on, updatedAt: now() })
          .where(eq(agentAreas.area, area))
          .run();
        options.record({
          action: "agents.can-use",
          outcome: "ok",
          ...by,
          subjectId: area,
          detail: { item: area, on },
        });
      });
      if (!on) options.onRevoked?.();
      options.onAreaChanged?.();
      return true;
    },

    /**
     * Switches one of an installed app's offers, writing the activity entry
     * in the same transaction. False, and nothing changed, when it already
     * has that answer.
     */
    setOffer(appId: string, id: string, on: boolean, by: ChangedBy): boolean {
      const offer = offersOf(appId)?.offers.get(id);
      if (!offer) throw new ActionCallError("not_found");
      const itemId = itemKey(offer);
      const row = itemRows(appId).get(itemId);
      if (row?.on === on) return false;
      db.transaction(() => {
        const set = {
          on,
          tier: offer.tier,
          updatedAt: now(),
        };
        db.insert(agentItems)
          .values({ appId, itemId, ...set })
          .onConflictDoUpdate({
            target: [agentItems.appId, agentItems.itemId],
            set,
          })
          .run();
        options.record({
          action: "agents.can-use",
          outcome: "ok",
          ...by,
          subjectId: id,
          detail: { app: appId, item: id, title: offer.title, on },
        });
      });
      if (!on) options.onRevoked?.();
      return true;
    },
  };
}

export type AgentsCanUse = ReturnType<typeof createAgentsCanUse>;
