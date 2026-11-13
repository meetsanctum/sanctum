import { confirmation } from "../../../waitlist/confirmation";

// GET /emails/waitlist: the waitlist's confirmation as a page, to look at
// while working on it, with its logo and its way off the list from this
// copy of the site and a contact nobody is. The published site has no such
// page.
export function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return new Response(null, { status: 404 });
  }
  const nobody = "00000000-0000-4000-8000-000000000000";
  const email = confirmation(nobody, new URL(request.url).origin);
  return new Response(email.html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
