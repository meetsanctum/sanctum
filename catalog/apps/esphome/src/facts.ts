import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { eq } from "drizzle-orm";

import { deviceFacts } from "./schema.js";

// What each device's connection last told, kept for its page.

/** A device's page, as its connection last told it. */
export type DeviceFacts = {
  address: string;
  encrypted: boolean;
  version: string | null;
  /** Its Wi-Fi signal in dBm, where it says it. */
  signal: number | null;
  unused: string[];
  sleeps: boolean;
  /** How its first key from Sanctum reached it, where that's worth saying. */
  firstKey: "setup" | null;
};

export function createFacts(db: SqliteRemoteDatabase) {
  return {
    /**
     * What a connection told, keeping the signal it said last, and how its
     * first key reached it unless this says.
     */
    async save(
      mac: string,
      facts: Omit<DeviceFacts, "signal" | "firstKey"> &
        Partial<Pick<DeviceFacts, "firstKey">>,
    ) {
      await db
        .insert(deviceFacts)
        .values({ mac, ...facts })
        .onConflictDoUpdate({ target: deviceFacts.mac, set: facts });
    },
    /** How its first key from Sanctum reached it, as Repair gave it anew. */
    async firstKey(mac: string, firstKey: "setup" | null) {
      await db
        .update(deviceFacts)
        .set({ firstKey })
        .where(eq(deviceFacts.mac, mac));
    },
    async signal(mac: string, signal: number) {
      await db
        .update(deviceFacts)
        .set({ signal })
        .where(eq(deviceFacts.mac, mac));
    },
    async read(mac: string): Promise<DeviceFacts | null> {
      const row = await db
        .select()
        .from(deviceFacts)
        .where(eq(deviceFacts.mac, mac))
        .get();
      if (!row) return null;
      const { mac: _mac, ...facts } = row;
      return facts;
    },
    async remove(mac: string) {
      await db.delete(deviceFacts).where(eq(deviceFacts.mac, mac));
    },
  };
}

export type Facts = ReturnType<typeof createFacts>;
