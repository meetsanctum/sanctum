import {
  aiAlwaysOn,
  aiAreas,
  aiAreasOnAtFirst,
  aiControlKinds,
  capabilityKinds,
  controlPermission,
  readPermission,
  type AiCanUse,
  type AiOfferInfo,
  type CapabilityKind,
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
// coming back keeps them.

/** One app's offers, as its contract keeps them. */
export type AppOffers = {
  app: string;
  offers: ReadonlyMap<string, DeclaredOffer>;
};

const tierRank = { read: 0, write: 1 } as const;
const isArea = (id: string) => aiAreas.includes(id);

export function createAgentsCanUse(
  db: CoreDatabase,
  options: {
    record: (entry: NewActivityEntry) => string;
    // The installed apps' offers, read on every listing.
    apps: () => readonly AppOffers[];
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

  // Whether an offer is on, with everything it needs: the core's areas, and
  // the app's own offers, which count with what they need in turn.
  function usableIn(
    app: AppOffers,
    rows: ReturnType<typeof itemRows>,
    id: string,
    seen: Set<string> = new Set(),
  ): boolean {
    const offer = app.offers.get(id);
    if (!offer || rows.get(id)?.on !== true || seen.has(id)) return false;
    seen.add(id);
    return offer.needs.every((need) =>
      isArea(need) ? areaOn(need) : usableIn(app, rows, need, seen),
    );
  }

  // What an offer needs that's off, so AI agents can't use it while it is on.
  function missingIn(
    app: AppOffers,
    rows: ReturnType<typeof itemRows>,
    offer: DeclaredOffer,
  ) {
    return offer.needs.filter((need) =>
      isArea(need)
        ? !areaOn(need)
        : !usableIn(app, rows, need, new Set([offer.id])),
    );
  }

  function offerInfo(app: AppOffers, rows: ReturnType<typeof itemRows>) {
    return [...app.offers.values()].map((offer): AiOfferInfo => ({
      app: app.app,
      id: offer.id,
      kind: offer.kind,
      title: offer.title,
      description: offer.description,
      on: rows.get(offer.id)?.on === true,
      needs: [...offer.needs],
      missing: missingIn(app, rows, offer),
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
      db.transaction(() => {
        for (const offer of app.offers.values()) {
          const row = rows.get(offer.id);
          const tier = offer.tier === "read" ? "read" : "write";
          if (!row) {
            db.insert(agentItems)
              .values({
                appId: app.app,
                itemId: offer.id,
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
          db.update(agentItems)
            .set(rose ? { tier, on: false, updatedAt } : { tier })
            .where(
              and(
                eq(agentItems.appId, app.app),
                eq(agentItems.itemId, offer.id),
              ),
            )
            .run();
        }
      });
    },

    areaOn,

    /** Whether AI agents may use one of an app's offers now. */
    canUse(appId: string, id: string): boolean {
      const app = offersOf(appId);
      return app ? usableIn(app, itemRows(appId), id) : false;
    },

    /**
     * The capability kinds AI agents may read and control. Controlling a
     * kind includes reading it, as it does for apps.
     */
    deviceKinds() {
      const controls = new Set<CapabilityKind>(
        aiControlKinds.filter((kind) => areaOn(controlPermission(kind))),
      );
      const reads = new Set<CapabilityKind>(
        capabilityKinds.filter(
          (kind) => controls.has(kind) || areaOn(readPermission(kind)),
        ),
      );
      return { reads, controls };
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
      const row = itemRows(appId).get(id);
      if (row?.on === on) return false;
      db.transaction(() => {
        const set = {
          on,
          tier: offer.tier === "read" ? ("read" as const) : ("write" as const),
          updatedAt: now(),
        };
        db.insert(agentItems)
          .values({ appId, itemId: id, ...set })
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
      return true;
    },
  };
}

export type AgentsCanUse = ReturnType<typeof createAgentsCanUse>;
