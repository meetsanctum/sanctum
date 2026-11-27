import {
  calendarDaysBetween,
  type HomeClock,
} from "@meetsanctum/app-sdk/clock";
import type {
  AgentInfo,
  ClientInfo,
  PersonInfo,
} from "@meetsanctum/auth-protocol";

import type { SignIn } from "./data";

// What Settings → People says. A shared tablet shows the same, so nothing
// here gives a username in the list or a time of day a device was used:
// names, avatars and whether someone signs in are the household's to see.

/** Names as people list them: "Alex", "Alex and Maya", "Alex, Maya and Sam". */
export function listed(names: readonly string[]) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Settings' row: everyone up to three, then the first and how many more. */
export function peopleSummary(names: readonly string[]) {
  if (names.length <= 3) return listed(names);
  return `${names[0]} and ${names.length - 1} more`;
}

/** The name a sentence calls someone by after the first time: Maya for Maya Keller. */
export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** When something ends, as people say it: today at 21:40, tomorrow at 21:40. */
export function untilText(clock: HomeClock, at: string, now = new Date()) {
  const end = new Date(at);
  const days = calendarDaysBetween(
    now.getTime(),
    end.getTime(),
    clock.timeZone,
  );
  const day =
    days === 0 ? "today" : days === 1 ? "tomorrow" : `on ${clock.dayText(end)}`;
  return `${day} at ${clock.timeText(end)}`;
}

/** A person's row in the list. */
export function signInLine(clock: HomeClock, signIn: SignIn, now?: Date) {
  switch (signIn.state) {
    case "signs-in":
      return "Signs in";
    case "invited":
      return `Invite works until ${untilText(clock, signIn.endsAt, now)}`;
    case "invite-ended":
      return "Invite ended";
    case "none":
      return "Doesn't sign in";
  }
}

/** When a device was last used, to the day: never a time of day. */
export function usedText(
  clock: HomeClock,
  client: ClientInfo,
  now = new Date(),
) {
  if (client.current) return "This device";
  if (client.connectedSince) return "Used today";
  if (!client.lastSeenAt) return "Not used yet";
  const seen = new Date(client.lastSeenAt);
  const days = calendarDaysBetween(
    seen.getTime(),
    now.getTime(),
    clock.timeZone,
  );
  if (days <= 0) return "Used today";
  if (days === 1) return "Used yesterday";
  return `Used on ${clock.dayText(seen)}`;
}

/**
 * What signs out with a person's sign-in, for its alerts: "Maya's iPhone and
 * MacBook Air sign out now." and "This device signs out now." Nothing when
 * no device is signed in.
 */
export function signsOutText(devices: readonly ClientInfo[]) {
  const others = devices.filter((client) => !client.current);
  const lines: string[] = [];
  if (others.length > 0) {
    const verb = others.length === 1 ? "signs" : "sign";
    lines.push(
      `${listed(others.map((client) => client.name))} ${verb} out now.`,
    );
  }
  if (devices.some((client) => client.current)) {
    lines.push("This device signs out now.");
  }
  return lines.join(" ");
}

/**
 * The AI agents a person added, which go with them: "Maya's AI agent
 * Claude is removed." Nothing when they added none.
 */
export function agentsGoText(agents: readonly AgentInfo[], person: PersonInfo) {
  const names = agents
    .filter(({ addedBy }) => addedBy.kind === "person")
    .filter(({ addedBy }) => addedBy.id === person.id)
    .map(({ name }) => name);
  if (names.length === 0) return null;
  const whose = `${firstName(person.name)}’s`;
  return names.length === 1
    ? `${whose} AI agent ${names[0]} is removed.`
    : `${whose} AI agents ${listed(names)} are removed.`;
}
