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
  /** When a smart speaker last heard its wake word, in ms since the epoch. */
  heardWakeWordAt: number | null;
};

/** What a connection tells of a device: all but what it says later. */
export type ConnectionFacts = Omit<DeviceFacts, "signal" | "heardWakeWordAt">;

export function createFacts(db: SqliteRemoteDatabase) {
  return {
    /** What a connection told, keeping the signal it said last. */
    async save(mac: string, facts: ConnectionFacts) {
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
    /** When a smart speaker heard its wake word, kept as the latest. */
    async heard(mac: string, at: number) {
      await db
        .update(deviceFacts)
        .set({ heardWakeWordAt: at })
        .where(eq(deviceFacts.mac, mac));
    },
    async remove(mac: string) {
      await db.delete(deviceFacts).where(eq(deviceFacts.mac, mac));
    },
  };
}

export type Facts = ReturnType<typeof createFacts>;
