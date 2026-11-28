import type {
  AgentInfo,
  ClientInfo,
  InviteEnded,
  InviteInfo,
  LoginInfo,
  PersonInfo,
} from "@meetsanctum/auth-protocol";
import type { LiveFeed } from "@meetsanctum/ui-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { coreJson } from "../core-fetch";
import { problemReason } from "../device-parts";

// What Settings → People reads: the household, who signs in and their
// invites, and on a person's page the clients and AI agents, for their
// devices and what goes with them. It reads
// again when the shell refreshes, when the activity log says a person
// changed, and after a change made here; nothing runs while it is still.

export type PeopleData = {
  people: PersonInfo[];
  logins: LoginInfo[];
  invites: InviteInfo[];
};

export function usePeople(live: LiveFeed, includeClients = false) {
  const [data, setData] = useState<
    PeopleData & { clients: ClientInfo[]; agents: AgentInfo[] }
  >();
  // Why the last read failed, until one succeeds.
  const [problem, setProblem] = useState<string>();
  const refreshId = useRef(0);
  const lastApplied = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++refreshId.current;
    try {
      const [people, logins, invites, clients, agents] = await Promise.all([
        coreJson<PersonInfo[]>("/api/people"),
        coreJson<LoginInfo[]>("/api/auth/logins"),
        coreJson<InviteInfo[]>("/api/auth/invites"),
        includeClients ? coreJson<ClientInfo[]>("/api/auth/clients") : [],
        includeClients ? coreJson<AgentInfo[]>("/api/auth/agents") : [],
      ]);
      // An older read that answers late never replaces a newer one.
      const loaded = { people, logins, invites, clients, agents };
      if (id >= lastApplied.current) {
        lastApplied.current = id;
        setData(loaded);
        setProblem(undefined);
      }
      return loaded;
    } catch (error) {
      if (id >= lastApplied.current) {
        lastApplied.current = id;
        setProblem(problemReason(error));
      }
    }
  }, [includeClients]);

  useEffect(() => {
    const update = () => void refresh();
    const stop = live.subscribe({
      refresh: update,
      message(message) {
        if (message.type !== "activity" || message.entry.outcome !== "ok")
          return;
        if (message.entry.source === "people") update();
      },
    });
    update();
    return () => {
      stop();
      lastApplied.current = ++refreshId.current;
    };
  }, [live, includeClients, refresh]);

  // An unused code can expire without generating an activity entry.
  useEffect(() => {
    const now = Date.now();
    let nextExpiry = Infinity;
    for (const invite of data?.invites ?? []) {
      const expires = Date.parse(invite.endsAt);
      if (!invite.ended && expires > now)
        nextExpiry = Math.min(nextExpiry, expires);
    }
    if (nextExpiry === Infinity) return;
    const timer = setTimeout(() => void refresh(), nextExpiry - now);
    return () => clearTimeout(timer);
  }, [data?.invites, refresh]);

  return { data, failed: problem !== undefined, problem, refresh };
}

/** How a person stands with signing in. */
export type SignIn =
  | { state: "signs-in"; username: string; reset: InviteInfo | null }
  | { state: "invited"; invite: InviteInfo }
  | { state: "invite-ended"; ended: InviteEnded }
  | { state: "none" };

export function signInOf(data: PeopleData, personId: string): SignIn {
  const login = data.logins.find((each) => each.personId === personId);
  const invite = data.invites.find((each) => each.personId === personId);
  if (login) {
    return {
      state: "signs-in",
      username: login.username,
      reset: invite?.kind === "reset" && !invite.ended ? invite : null,
    };
  }
  if (invite?.kind === "invite") {
    return invite.ended
      ? { state: "invite-ended", ended: invite.ended }
      : { state: "invited", invite };
  }
  return { state: "none" };
}

/** A person's own devices that are signed in, this one first. */
export function devicesOf(clients: readonly ClientInfo[], personId: string) {
  return clients
    .filter((client) => client.kind === "personal")
    .filter((client) => client.personId === personId)
    .sort((a, b) => Number(b.current) - Number(a.current));
}

/**
 * Whether removing this person's sign-in would leave nobody who signs in,
 * which the core refuses: the page says so before anyone presses.
 */
export function holdsLastSignIn(data: PeopleData, personId: string) {
  return data.logins.length === 1 && data.logins[0]!.personId === personId;
}
