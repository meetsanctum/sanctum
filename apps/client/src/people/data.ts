import type {
  ClientInfo,
  InviteInfo,
  LoginInfo,
  PersonInfo,
} from "@meetsanctum/auth-protocol";
import { useCallback, useEffect, useRef, useState } from "react";

import { coreJson } from "../core-fetch";
import { everyWhileShown } from "../while-shown";

// What Settings → People reads: the household, who signs in, their invites
// and the clients, for each person's devices. Read again every few seconds
// while shown, as Clients is, so a person who joins or a device that signs
// out elsewhere shows up, and at once after a change made here.

export type PeopleData = {
  people: PersonInfo[];
  logins: LoginInfo[];
  invites: InviteInfo[];
  clients: ClientInfo[];
};

export function usePeople() {
  const [data, setData] = useState<PeopleData>();
  const [failed, setFailed] = useState(false);
  const refreshId = useRef(0);
  const lastApplied = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++refreshId.current;
    try {
      const [people, logins, invites, clients] = await Promise.all([
        coreJson<PersonInfo[]>("/api/people"),
        coreJson<LoginInfo[]>("/api/auth/logins"),
        coreJson<InviteInfo[]>("/api/auth/invites"),
        coreJson<ClientInfo[]>("/api/auth/clients"),
      ]);
      // An older read that answers late never replaces a newer one.
      if (id < lastApplied.current) return;
      lastApplied.current = id;
      setData({ people, logins, invites, clients });
      setFailed(false);
    } catch {
      if (id >= lastApplied.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    const update = () => void refresh();
    update();
    return everyWhileShown(5_000, update);
  }, [refresh]);

  return { data, failed, refresh };
}

/** How a person stands with signing in. */
export type SignIn =
  | { state: "signs-in"; username: string; reset: InviteInfo | null }
  | { state: "invited"; invite: InviteInfo }
  | { state: "invite-ended"; invite: InviteInfo }
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
      ? { state: "invite-ended", invite }
      : { state: "invited", invite };
  }
  return { state: "none" };
}

/** A person's own devices that are signed in, this one first. */
export function devicesOf(data: PeopleData, personId: string) {
  return data.clients
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
