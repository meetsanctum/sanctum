import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { eq, getTableColumns } from "drizzle-orm";

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

/** What a connection tells of a device: all but what it says later. */
type ConnectionFacts = Omit<DeviceFacts, "signal">;

const { mac, heardWakeWordAt, ...pageFields } = getTableColumns(deviceFacts);

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
        .select(pageFields)
        .from(deviceFacts)
        .where(eq(deviceFacts.mac, mac))
        .get();
      return row ?? null;
    },
    /** When a smart speaker heard its wake word, kept as the latest. */
    async heard(
      mac: string,
      at: number,
      connection: Omit<ConnectionFacts, "firstKey">,
    ) {
      await db
        .insert(deviceFacts)
        .values({ mac, ...connection, heardWakeWordAt: at })
        .onConflictDoUpdate({
          target: deviceFacts.mac,
          set: { heardWakeWordAt: at },
        });
    },
    async lastHeard(key: string) {
      const row = await db
        .select({ heardWakeWordAt })
        .from(deviceFacts)
        .where(eq(mac, key))
        .get();
      return row?.heardWakeWordAt ?? null;
    },
    async remove(mac: string) {
      await db.delete(deviceFacts).where(eq(deviceFacts.mac, mac));
    },
  };
}

export type Facts = ReturnType<typeof createFacts>;
