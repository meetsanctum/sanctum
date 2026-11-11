import { asc, count, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ChangedBy, RecordActivity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import { people } from "./schema.js";

// The People module: who lives in the home and how they look across the
// apps. Claiming the host adds the first person; every client adds, changes
// and removes the rest through its routes (routes.ts). There are no roles:
// everyone may do the same.

export type Person = typeof people.$inferSelect;

// One person changed: added, changed or removed.
export type PersonChange = {
  id: string;
  before: Person | null;
  after: Person | null;
};

const name = z.string().trim().min(1).max(60);
// An avatar from the set the apps ship, by its key.
const avatar = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
  .nullable();
const colour = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i)
  .transform((value) => value.toLowerCase());
export const newPerson = z.object({
  name,
  avatar: avatar.default(null),
  colour,
});
export const personChanges = z.object({ name, avatar, colour }).partial();

export type NewPerson = z.input<typeof newPerson>;
export type PersonChanges = z.input<typeof personChanges>;

export class PeopleError extends Error {
  constructor(
    readonly code: "not_found" | "last_login",
    message: string,
  ) {
    super(message);
  }
}

export function createPeople(
  db: CoreDatabase,
  options: {
    // Whether the host has been claimed, and how many people could still
    // sign in: Auth counts those with a login, and without it everyone
    // counts. Both read through the same connection, so they are part of the
    // change's transaction.
    isClaimed: () => boolean;
    countLogins?: () => number;
    // Writes a change made through People's routes to the activity log, in
    // the change's transaction.
    record?: RecordActivity;
    // Called after a change has committed, so running apps can follow.
    onChange?: (change: PersonChange) => void;
  },
) {
  // A claimed host always keeps someone who can sign in. Checked inside the
  // change's transaction, after the change, so a refusal undoes it.
  function assertLoginRemains(tx: Pick<CoreDatabase, "select">) {
    if (!options.isClaimed()) {
      return;
    }
    const logins =
      options.countLogins?.() ??
      tx.select({ count: count() }).from(people).get()?.count;
    if (!logins) {
      throw new PeopleError(
        "last_login",
        "A claimed host must keep someone who can sign in",
      );
    }
  }

  function notFound(id: string) {
    return new PeopleError("not_found", `No person ${id}`);
  }

  function get(id: string): Person | undefined {
    return db.select().from(people).where(eq(people.id, id)).get();
  }

  // Tells whoever follows People once a change has committed. Changes made
  // inside a caller's transaction, as the claim's (auth/logins.ts), wait
  // here with each person as they were before the first, since what came
  // between may never commit. Transactions here are synchronous, so they
  // are over by the next microtask, which tells what they left; so does
  // People's next change, before its own.
  const pending = new Map<string, Person | null>();
  function flushChanges() {
    if (db.$client.inTransaction) return;
    const changes = [...pending].map(([id, before]) => ({
      id,
      before,
      after: get(id) ?? null,
    }));
    pending.clear();
    for (const change of changes) {
      if (JSON.stringify(change.before) !== JSON.stringify(change.after)) {
        options.onChange?.(change);
      }
    }
  }

  function changed(id: string, before: Person | null, after: Person | null) {
    if (!db.$client.inTransaction) {
      options.onChange?.({ id, before, after });
      return;
    }
    if (pending.size === 0) queueMicrotask(flushChanges);
    if (!pending.has(id)) pending.set(id, before);
  }

  function log(
    by: ChangedBy | undefined,
    action: string,
    subjectId: string,
    detail?: Record<string, unknown>,
  ) {
    if (by) {
      options.record?.({
        action,
        outcome: "ok",
        personId: by.personId,
        clientId: by.clientId,
        subjectId,
        detail,
      });
    }
  }

  return {
    list(): Person[] {
      return db
        .select()
        .from(people)
        .orderBy(asc(people.createdAt), asc(people.name))
        .all();
    },

    get,

    add(input: NewPerson, by?: ChangedBy): Person {
      flushChanges();
      const values = newPerson.parse(input);
      const now = new Date();
      const person = db.transaction((tx) => {
        const added = tx
          .insert(people)
          .values({
            id: randomUUID(),
            ...values,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        log(by, "person.add", added.id);
        return added;
      });
      changed(person.id, null, person);
      return person;
    },

    update(id: string, input: PersonChanges, by?: ChangedBy): Person {
      flushChanges();
      const changes = personChanges.parse(input);
      const before = get(id) ?? null;
      const person = db.transaction((tx) => {
        const updated = tx
          .update(people)
          .set({ ...changes, updatedAt: new Date() })
          .where(eq(people.id, id))
          .returning()
          .get();
        if (!updated) {
          throw notFound(id);
        }
        log(by, "person.update", id);
        return updated;
      });
      changed(id, before, person);
      return person;
    },

    // Their login and personal clients go with them (auth/schema.ts).
    remove(id: string, by?: ChangedBy) {
      flushChanges();
      const person = db.transaction((tx) => {
        const removed = tx
          .delete(people)
          .where(eq(people.id, id))
          .returning()
          .get();
        if (!removed) {
          throw notFound(id);
        }
        assertLoginRemains(tx);
        // Its name, for the entries that name the person.
        log(by, "person.remove", id, { name: removed.name });
        return removed;
      });
      changed(id, person, null);
    },
  };
}

export type People = ReturnType<typeof createPeople>;
