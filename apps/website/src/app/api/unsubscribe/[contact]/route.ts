import { Resend } from "resend";

import { isContactId, leaveWaitlist } from "../../../../waitlist/join";

type Context = { params: Promise<{ contact: string }> };

// POST /api/unsubscribe/<contact>
//
// Takes the contact off the waitlist. The confirmation names this address
// in its List-Unsubscribe header, so a mail app's own Unsubscribe posts
// here, and the site's page for leaving does too. A contact already gone
// has left as well.
export async function POST(_request: Request, context: Context) {
  const { contact } = await context.params;
  if (!isContactId(contact)) return new Response(null, { status: 404 });
  const key = process.env.RESEND_API_KEY;
  if (!key) return new Response(null, { status: 503 });
  const outcome = await leaveWaitlist(new Resend(key), contact);
  return new Response(null, { status: outcome === "left" ? 200 : 502 });
}

// Opened rather than posted to, it is the page for leaving.
export async function GET(_request: Request, context: Context) {
  const { contact } = await context.params;
  if (!isContactId(contact)) return new Response(null, { status: 404 });
  return new Response(null, {
    status: 303,
    headers: { location: `/unsubscribe/${contact}` },
  });
}
