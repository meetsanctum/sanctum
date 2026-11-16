import type { AppPages, PageTicket } from "@meetsanctum/auth-protocol";

import { coreJson, currentCredential } from "../core-fetch";
import { coreBaseUrl, coreUrl } from "../core-url";

// This client's page ticket, which the addresses of apps' pages in frames
// start with, since a frame's loads can't carry the client's token. It's
// asked for once and kept while the shell runs, for this core and this
// client's token, and asked for again a day before it ends: each works a
// day past its week, so a page that's open keeps loading.

const renewBeforeMs = 24 * 60 * 60_000;

type Held = {
  holder: string;
  ticket: Promise<PageTicket>;
  endsAt?: number;
};

let held: Held | undefined;

/** This client's page ticket, and the home's kit with it. */
export function pageTicket(now = Date.now()): Promise<PageTicket> {
  const holder = `${coreBaseUrl()} ${currentCredential()?.token ?? ""}`;
  if (
    held?.holder === holder &&
    (held.endsAt === undefined || held.endsAt - renewBeforeMs > now)
  ) {
    return held.ticket;
  }
  const next: Held = {
    holder,
    ticket: coreJson<PageTicket>("/api/pages/ticket", { method: "POST" }),
  };
  held = next;
  next.ticket.then(
    (ticket) => {
      next.endsAt = Date.parse(ticket.expiresAt);
    },
    () => {
      if (held === next) held = undefined;
    },
  );
  return next.ticket;
}

/** Asks for a new ticket next time, as when a page in a frame didn't load. */
export function forgetPageTicket() {
  held = undefined;
}

/**
 * Where an app's page loads from: the entry the core writes for its build
 * now, under this client's ticket, with the code the frame says hello with.
 */
export async function pageAddress(appId: string, code: string) {
  const [ticket, pages] = await Promise.all([
    pageTicket(),
    coreJson<AppPages>(`/api/pages/apps/${encodeURIComponent(appId)}`),
  ]);
  const path = `/pages/${ticket.ticket}/apps/${encodeURIComponent(appId)}/${pages.digest}/`;
  return { kit: ticket.kit, url: `${coreUrl(path)}#hello=${code}` };
}
