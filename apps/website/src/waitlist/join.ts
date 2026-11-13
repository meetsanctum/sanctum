import type { WaitlistEmail } from "./email";

// What the waitlist needs of Resend: its contacts, which are the waitlist,
// and its emails, for the confirmation. Resend's client fits it as it is.
type Answer<Data = unknown> = {
  data: Data | null;
  error: { message: string; name?: string } | null;
};
export interface WaitlistMailer {
  contacts: {
    create(contact: {
      email: string;
      segments?: { id: string }[];
    }): Promise<Answer<{ id: string }>>;
    get(contact: { email: string }): Promise<Answer<{ id: string }>>;
    remove(contact: { id: string }): Promise<Answer>;
    segments: {
      list(contact: {
        contactId: string;
        limit?: number;
      }): Promise<Answer<{ data: { id: string }[] }>>;
      add(membership: {
        contactId: string;
        segmentId: string;
      }): Promise<Answer>;
      remove(membership: {
        contactId: string;
        segmentId: string;
      }): Promise<Answer>;
    };
  };
  emails: {
    send(email: {
      from: string;
      to: string;
      subject: string;
      html: string;
      text: string;
      headers: Record<string, string>;
    }): Promise<Answer>;
  };
}

/** An address a mail server could take: one @, a dot after it, no spaces. */
export function isEmailAddress(text: string) {
  return text.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

/** A contact's id as Resend writes it. */
export function isContactId(text: string) {
  return /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(text);
}

/**
 * Puts an address on the waitlist and confirms it by email, once: an
 * address already on the list is left as it is and gets no second email.
 * "failed" means the address is not on the list.
 */
export async function joinWaitlist(
  mailer: WaitlistMailer,
  joining: {
    email: string;
    /** Who the confirmation is from, such as "Name <hello@example.com>". */
    from: string;
    /** The segment of contacts the waitlist is, if they are kept in one. */
    segment?: string;
    /** The confirmation for a contact, whose id its way off the list holds. */
    confirmation: (contact: string) => WaitlistEmail;
  },
): Promise<"joined" | "already" | "failed"> {
  const { email, segment } = joining;
  const created = await mailer.contacts.create({
    email,
    ...(segment ? { segments: [{ id: segment }] } : {}),
  });
  let contact = created.data?.id;
  if (created.error || !contact) {
    // Whatever Resend says of an address it already has, having it settles
    // the question.
    const existing = await mailer.contacts.get({ email });
    if (existing.error || !existing.data) {
      return kept(created.error?.message ?? "no contact came back");
    }
    contact = existing.data.id;
    if (!segment) return "already";
    // A contact can be Resend's for another reason than the waitlist: only
    // one in the waitlist's segment is on it, and any other joins it now.
    const segments = await mailer.contacts.segments.list({
      contactId: contact,
      limit: 100,
    });
    if (segments.error || !segments.data) {
      return kept(segments.error?.message ?? "its segments didn't come back");
    }
    if (segments.data.data.some(({ id }) => id === segment)) return "already";
    const added = await mailer.contacts.segments.add({
      contactId: contact,
      segmentId: segment,
    });
    if (added.error) return kept(added.error.message);
  }
  const sent = await mailer.emails.send({
    from: joining.from,
    to: email,
    ...joining.confirmation(contact),
  });
  // The address is on the list either way; the email only says so.
  if (sent.error) {
    console.error(
      `The waitlist's confirmation wasn't sent: ${sent.error.message}`,
    );
  }
  return "joined";
}

function kept(why: string) {
  console.error(`The waitlist kept no address: ${why}`);
  return "failed" as const;
}

/**
 * Takes a contact off the waitlist. Its address goes with it, unless the
 * waitlist is a segment and the contact is in others too: then it leaves
 * only the waitlist's. One already gone has left as well, so asking twice
 * is no failure.
 */
export async function leaveWaitlist(
  mailer: WaitlistMailer,
  contact: string,
  /** The segment of contacts the waitlist is, if they are kept in one. */
  segment?: string,
): Promise<"left" | "failed"> {
  if (segment) {
    const segments = await mailer.contacts.segments.list({
      contactId: contact,
      limit: 100,
    });
    if (segments.error || !segments.data) {
      return gone(
        segments.error ?? { message: "its segments didn't come back" },
      );
    }
    if (segments.data.data.some(({ id }) => id !== segment)) {
      const left = await mailer.contacts.segments.remove({
        contactId: contact,
        segmentId: segment,
      });
      return left.error ? gone(left.error) : "left";
    }
  }
  const removed = await mailer.contacts.remove({ id: contact });
  return removed.error ? gone(removed.error) : "left";
}

function gone(error: { message: string; name?: string }) {
  if (error.name === "not_found") return "left" as const;
  console.error(`The waitlist kept a contact: ${error.message}`);
  return "failed" as const;
}
