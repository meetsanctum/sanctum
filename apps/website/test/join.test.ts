import { describe, expect, it, vi } from "vitest";

import {
  isContactId,
  isEmailAddress,
  joinWaitlist,
  leaveWaitlist,
  type WaitlistMailer,
} from "../src/waitlist/join";

// The waitlist: an address becomes a contact and hears so once, and a
// contact leaves again.

type Refusal = { message: string; name?: string };
const refused: Refusal = { message: "refused" };
const contact = "0b4d2f6e-3a1c-4e5f-8a9b-7c6d5e4f3a2b";

function mailer(refusals: {
  create?: Refusal;
  get?: Refusal;
  remove?: Refusal;
  send?: Refusal;
}) {
  const answer = (refusal?: Refusal) =>
    vi.fn(async () =>
      refusal ? { data: null, error: refusal } : { data: {}, error: null },
    );
  return {
    contacts: {
      create: vi.fn(async () =>
        refusals.create
          ? { data: null, error: refusals.create }
          : { data: { id: contact }, error: null },
      ),
      get: answer(refusals.get),
      remove: answer(refusals.remove),
    },
    emails: { send: answer(refusals.send) },
  } satisfies WaitlistMailer;
}

const confirmation = vi.fn((id: string) => ({
  subject: "Subject",
  html: `<p>${id}</p>`,
  text: id,
  headers: { "List-Unsubscribe": `<https://example.com/${id}>` },
}));
const joining = {
  email: "someone@example.com",
  from: "Example <hello@example.com>",
  confirmation,
};

describe("joining the waitlist", () => {
  it("keeps the address and sends its contact the confirmation", async () => {
    const resend = mailer({});
    expect(await joinWaitlist(resend, joining)).toBe("joined");
    expect(resend.contacts.create).toHaveBeenCalledWith({
      email: "someone@example.com",
    });
    expect(resend.emails.send).toHaveBeenCalledWith({
      from: "Example <hello@example.com>",
      to: "someone@example.com",
      subject: "Subject",
      html: `<p>${contact}</p>`,
      text: contact,
      headers: { "List-Unsubscribe": `<https://example.com/${contact}>` },
    });
  });

  it("puts the contact in the waitlist's segment when there is one", async () => {
    const resend = mailer({});
    await joinWaitlist(resend, { ...joining, segment: "segment-1" });
    expect(resend.contacts.create).toHaveBeenCalledWith({
      email: "someone@example.com",
      segments: [{ id: "segment-1" }],
    });
  });

  it("sends an address already on the list nothing more", async () => {
    const resend = mailer({ create: refused });
    expect(await joinWaitlist(resend, joining)).toBe("already");
    expect(resend.contacts.get).toHaveBeenCalledWith({
      email: "someone@example.com",
    });
    expect(resend.emails.send).not.toHaveBeenCalled();
  });

  it("fails when the address could not be kept", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const resend = mailer({ create: refused, get: refused });
    expect(await joinWaitlist(resend, joining)).toBe("failed");
    expect(resend.emails.send).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("has joined even when the confirmation could not be sent", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await joinWaitlist(mailer({ send: refused }), joining)).toBe(
      "joined",
    );
    log.mockRestore();
  });
});

describe("leaving the waitlist", () => {
  it("removes the contact", async () => {
    const resend = mailer({});
    expect(await leaveWaitlist(resend, contact)).toBe("left");
    expect(resend.contacts.remove).toHaveBeenCalledWith({ id: contact });
  });

  it("has left when the contact is already gone", async () => {
    const gone = { message: "Contact not found", name: "not_found" };
    expect(await leaveWaitlist(mailer({ remove: gone }), contact)).toBe("left");
  });

  it("fails when the contact could not be removed", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await leaveWaitlist(mailer({ remove: refused }), contact)).toBe(
      "failed",
    );
    log.mockRestore();
  });
});

describe("an email address", () => {
  it("has a name, an @ and a domain with a dot", () => {
    for (const address of ["a@b.co", "first.last+tag@mail.example.com"]) {
      expect(isEmailAddress(address)).toBe(true);
    }
    for (const address of [
      "",
      "name",
      "name@",
      "@example.com",
      "name@example",
      "na me@example.com",
      "a@b@example.com",
      `${"a".repeat(250)}@b.co`,
    ]) {
      expect(isEmailAddress(address)).toBe(false);
    }
  });
});

describe("a contact's id", () => {
  it("is a UUID and nothing around it", () => {
    expect(isContactId(contact)).toBe(true);
    for (const id of ["", "1", `${contact}/..`, ` ${contact}`, "../waitlist"]) {
      expect(isContactId(id)).toBe(false);
    }
  });
});
