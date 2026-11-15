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
};

export function createFacts(db: SqliteRemoteDatabase) {
  return {
    /** What a connection told, keeping the signal it said last. */
    async save(mac: string, facts: Omit<DeviceFacts, "signal">) {
      await db
        .insert(deviceFacts)
        .values({ mac, ...facts })
        .onConflictDoUpdate({ target: deviceFacts.mac, set: facts });
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
