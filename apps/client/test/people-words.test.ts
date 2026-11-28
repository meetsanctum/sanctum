import { homeClock } from "@meetsanctum/app-sdk/clock";
import type { ClientInfo, InviteInfo } from "@meetsanctum/auth-protocol";
import { describe, expect, it } from "vitest";

import {
  devicesOf,
  holdsLastSignIn,
  signInOf,
  type PeopleData,
} from "../src/people/data";
import {
  agentsGoText,
  firstName,
  peopleSummary,
  signInLine,
  signsOutText,
  untilText,
  usedText,
} from "../src/people/words";

// Settings → People: how each person stands with signing in, and how the
// list, a person's page and its alerts say it.

const clock = homeClock({ timeZone: "Europe/Zurich", hourCycle: "24h" });
const now = new Date("2026-11-27T18:00:00Z");

function client(changes: Partial<ClientInfo>): ClientInfo {
  return {
    id: "c",
    name: "Maya's iPhone",
    kind: "personal",
    platform: "ios",
    personId: "maya",
    createdAt: "2026-11-01T10:00:00Z",
    lastSeenAt: null,
    connectedSince: null,
    current: false,
    reduceEffects: false,
    reduceMotion: false,
    ...changes,
  };
}

function invite(changes: Partial<InviteInfo>): InviteInfo {
  return {
    id: "invite",
    personId: "sam",
    kind: "invite",
    createdAt: "2026-11-27T17:00:00Z",
    endsAt: "2026-11-28T20:40:00Z",
    ended: null,
    ...changes,
  };
}

const household: PeopleData & { clients: ClientInfo[] } = {
  people: [
    { id: "alex", name: "Alex Keller", avatar: null, colour: "#c5cdac" },
    { id: "maya", name: "Maya Keller", avatar: null, colour: "#b9defc" },
    { id: "sam", name: "Sam", avatar: null, colour: "#fcd2b3" },
    { id: "ida", name: "Ida", avatar: null, colour: "#dbcaf5" },
  ],
  logins: [
    { personId: "alex", username: "alex" },
    { personId: "maya", username: "maya" },
  ],
  invites: [
    invite({}),
    invite({ personId: "maya", kind: "reset" }),
    invite({ personId: "ida", ended: "cancelled" }),
  ],
  clients: [
    client({ id: "phone" }),
    client({ id: "laptop", name: "MacBook Air", current: true }),
    client({ id: "kitchen", kind: "shared", personId: null }),
    client({ id: "alex", personId: "alex" }),
  ],
};

describe("signing in", () => {
  it("is a person's sign-in, open invite, ended invite or none", () => {
    expect(signInOf(household, "alex")).toEqual({
      state: "signs-in",
      username: "alex",
      reset: null,
      recovery: null,
    });
    expect(signInOf(household, "maya")).toMatchObject({
      state: "signs-in",
      reset: household.invites[1],
    });
    expect(signInOf(household, "sam")).toMatchObject({ state: "invited" });
    expect(signInOf(household, "ida")).toMatchObject({
      state: "invite-ended",
    });
    expect(signInOf({ ...household, invites: [] }, "sam")).toEqual({
      state: "none",
    });
  });

  it("keeps a recovery code apart from an invite or reset", () => {
    const recovery = invite({ personId: "maya", kind: "recovery" });
    const withRecovery = {
      ...household,
      invites: [...household.invites, recovery],
    };
    expect(signInOf(withRecovery, "maya")).toMatchObject({
      state: "signs-in",
      reset: household.invites[1],
      recovery,
    });
  });

  it("reads in the list without usernames", () => {
    const line = (id: string) =>
      signInLine(clock, signInOf(household, id), now);
    expect(line("alex")).toBe("Signs in");
    expect(line("sam")).toBe("Invite works until tomorrow at 21:40");
    expect(line("ida")).toBe("Invite ended");
    expect(signInLine(clock, { state: "none" })).toBe("Doesn't sign in");
  });

  it("keeps the home's last sign-in", () => {
    const alone = {
      ...household,
      logins: [{ personId: "alex", username: "alex" }],
    };
    expect(holdsLastSignIn(alone, "alex")).toBe(true);
    expect(holdsLastSignIn(household, "alex")).toBe(false);
    expect(holdsLastSignIn(alone, "sam")).toBe(false);
  });
});

describe("a person's devices", () => {
  it("are their own personal clients, this one first", () => {
    expect(devicesOf(household.clients, "maya").map(({ id }) => id)).toEqual([
      "laptop",
      "phone",
    ]);
  });

  it("say the day they were used, never the time", () => {
    const at = (lastSeenAt: string) =>
      usedText(clock, client({ lastSeenAt }), now);
    expect(at("2026-11-27T07:00:00Z")).toBe("Used today");
    expect(at("2026-11-26T07:00:00Z")).toBe("Used yesterday");
    expect(at("2026-11-03T07:00:00Z")).toBe("Used on 3 Nov");
    expect(usedText(clock, client({ connectedSince: now.toISOString() }))).toBe(
      "Connected now",
    );
    expect(usedText(clock, client({ current: true }))).toBe("This device");
    expect(usedText(clock, client({}))).toBe("Not used yet");
  });

  it("are named in the alerts that sign them out", () => {
    expect(signsOutText(devicesOf(household.clients, "maya"))).toBe(
      "Maya's iPhone signs out now. This device signs out now.",
    );
    expect(
      signsOutText([client({}), client({ id: "air", name: "MacBook Air" })]),
    ).toBe("Maya's iPhone and MacBook Air sign out now.");
    expect(signsOutText([])).toBe("");
  });
});

describe("the household's names", () => {
  it("are listed up to three, then counted", () => {
    expect(peopleSummary(["Alex"])).toBe("Alex");
    expect(peopleSummary(["Alex", "Maya", "Sam"])).toBe("Alex, Maya and Sam");
    expect(peopleSummary(["Alex", "Maya", "Sam", "Ida"])).toBe(
      "Alex and 3 more",
    );
  });

  it("call someone by their first name after the first time", () => {
    expect(firstName("Maya Keller")).toBe("Maya");
    expect(firstName("Sam")).toBe("Sam");
  });

  it("say when something ends by the home's day", () => {
    expect(untilText(clock, "2026-11-27T20:40:00Z", now)).toBe(
      "today at 21:40",
    );
    expect(untilText(clock, "2026-11-30T08:00:00Z", now)).toBe(
      "on 30 Nov at 09:00",
    );
  });
});

describe("removing a person", () => {
  it("names the AI agents they added, and nothing when they added none", () => {
    const agent = (id: string, name: string, by: string) => ({
      id,
      name,
      platform: "macos" as const,
      addedBy: { kind: "person" as const, id: by, name: null },
      createdAt: "2026-11-20T10:00:00Z",
      lastSeenAt: null,
    });
    const maya = household.people[1]!;
    expect(agentsGoText([agent("a", "Claude", "maya")], maya)).toBe(
      "Maya’s AI agent Claude is removed.",
    );
    expect(
      agentsGoText(
        [agent("a", "Claude", "maya"), agent("b", "Codex", "maya")],
        maya,
      ),
    ).toBe("Maya’s AI agents Claude and Codex are removed.");
    expect(agentsGoText([agent("a", "Claude", "alex")], maya)).toBeNull();
  });
});
