import { Resend } from "resend";

import { confirmation } from "../../../waitlist/confirmation";
import { isEmailAddress, joinWaitlist } from "../../../waitlist/join";

// POST /api/waitlist  { email }
//
// Puts the address among Resend's contacts and sends it the confirmation.
// RESEND_API_KEY and WAITLIST_FROM, the confirmation's sender, turn it on;
// without them it answers 503 and keeps nothing. RESEND_SEGMENT_ID names
// the segment the contacts join, if any.
export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const fields = body && typeof body === "object" ? body : {};
  const email =
    "email" in fields && typeof fields.email === "string"
      ? fields.email.trim()
      : "";
  if (!isEmailAddress(email)) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }
  // The form's hidden field, which only a script fills in: it hears the
  // same answer, and nothing is kept.
  if ("company" in fields && fields.company) {
    return Response.json({ ok: true });
  }

  const key = process.env.RESEND_API_KEY;
  const from = process.env.WAITLIST_FROM;
  if (!key || !from) {
    return Response.json({ error: "not-set-up" }, { status: 503 });
  }
  const outcome = await joinWaitlist(new Resend(key), {
    email,
    from,
    segment: process.env.RESEND_SEGMENT_ID || undefined,
    confirmation,
  });
  if (outcome === "failed") {
    return Response.json({ error: "failed" }, { status: 502 });
  }
  // The same answer whether the address was new, so the form tells nobody
  // who is on the list.
  return Response.json({ ok: true });
}
