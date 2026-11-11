import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import { openCoreDatabase } from "../src/database.js";
import { createPeople, PeopleError } from "../src/people/people.js";

async function household(options: { claimed: boolean }) {
  const { db } = openCoreDatabase(
    await mkdtemp(join(tmpdir(), "sanctum-core-")),
  );
  const people = createPeople(db, { isClaimed: () => options.claimed });
  return { db, people };
}

const maya = { name: "Maya", colour: "#C5CDAC" } as const;
const jonas = { name: "Jonas", colour: "#b9defc" } as const;

afterEach(() => vi.useRealTimers());

describe("people", () => {
  it("adds, lists, changes and removes people", async () => {
    const { people } = await household({ claimed: false });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const added = people.add({ ...maya, name: "  Maya " });
    vi.setSystemTime(new Date("2026-01-01T00:00:01Z"));
    const other = people.add({ ...jonas, avatar: "fox" });
    expect(added).toMatchObject({
      name: "Maya",
      avatar: null,
      colour: "#c5cdac",
    });
    expect(people.list().map((person) => person.name)).toEqual([
      "Maya",
      "Jonas",
    ]);

    const changed = people.update(other.id, { avatar: null });
    expect(changed).toMatchObject({
      name: "Jonas",
      avatar: null,
    });
    expect(changed.updatedAt.getTime()).toBeGreaterThanOrEqual(
      other.updatedAt.getTime(),
    );
    expect(people.get(other.id)).toEqual(changed);

    people.remove(other.id);
    expect(people.get(other.id)).toBeUndefined();
    expect(people.list()).toHaveLength(1);
  });

  it("checks names, avatars and colours", async () => {
    const { people } = await household({ claimed: false });

    for (const input of [
      { ...maya, name: " " },
      { ...maya, name: "x".repeat(61) },
      { ...maya, avatar: "../fox.png" },
      { ...maya, colour: "sage" },
    ]) {
      expect(() => people.add(input as typeof maya)).toThrow(ZodError);
    }
    expect(people.list()).toEqual([]);
  });

  it("reports people that do not exist", async () => {
    const { people } = await household({ claimed: false });

    expect(() => people.update("nobody", { name: "Ruth" })).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(() => people.remove("nobody")).toThrow(PeopleError);
  });
});

describe("a claimed host", () => {
  it("keeps someone who can sign in", async () => {
    const { people } = await household({ claimed: true });
    const only = people.add(maya);

    expect(() => people.remove(only.id)).toThrow(
      expect.objectContaining({ code: "last_login" }),
    );
    // A refused change leaves nothing behind.
    expect(people.get(only.id)).toMatchObject({ name: "Maya" });
  });

  it("lets someone go while another remains", async () => {
    const { people } = await household({ claimed: true });
    const first = people.add(maya);
    people.add(jonas);

    people.remove(first.id);

    expect(people.list()).toMatchObject([{ name: "Jonas" }]);
  });
});

describe("an unclaimed host", () => {
  it("has no one to keep yet", async () => {
    const { people } = await household({ claimed: false });
    const admin = people.add(maya);

    people.remove(admin.id);

    expect(people.list()).toEqual([]);
  });
});

describe("people inside a larger change", () => {
  it("roll back with it", async () => {
    // Claiming the host adds its first person in Auth's own transaction.
    const { db, people } = await household({ claimed: false });

    expect(() =>
      db.transaction(() => {
        people.add(maya);
        people.update(people.add(jonas).id, { name: "Jo" });
        throw new Error("claiming failed");
      }),
    ).toThrow("claiming failed");

    expect(people.list()).toEqual([]);
  });
});
