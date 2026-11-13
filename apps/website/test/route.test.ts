import { afterEach, describe, expect, it, vi } from "vitest";

// The waitlist's routes, with Resend's client replaced: what they answer,
// and what they ask of Resend.

type Answer = { data: unknown; error: { message: string } | null };
const contact = "0b4d2f6e-3a1c-4e5f-8a9b-7c6d5e4f3a2b";
const down: Answer = { data: null, error: { message: "down" } };

const resend = vi.hoisted(() => ({
  keys: [] as string[],
  create: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
  add: vi.fn(),
  leave: vi.fn(),
  send: vi.fn(),
}));
vi.mock("resend", () => ({
  Resend: class {
    contacts = {
      create: resend.create,
      get: resend.get,
      remove: resend.remove,
      segments: {
        list: resend.list,
        add: resend.add,
        remove: resend.leave,
      },
    };
    emails = { send: resend.send };
    constructor(key: string) {
      resend.keys.push(key);
    }
  },
}));
// The real one takes the logo from the built site.
vi.mock("../src/waitlist/confirmation", () => ({
  confirmation: (id: string) => ({
    subject: "Subject",
    html: `<p>${id}</p>`,
    text: id,
    headers: { "List-Unsubscribe": `<https://example.com/${id}>` },
  }),
}));

const waitlist = await import("../src/app/api/waitlist/route");
const unsubscribe = await import("../src/app/api/unsubscribe/[contact]/route");

// Each join comes from a client of its own unless a test names one, as the
// route counts joins by client.
let clients = 0;
const join = (body: unknown, client = `client-${++clients}`) =>
  waitlist.POST(
    new Request("https://example.com/api/waitlist", {
      method: "POST",
      headers: { "x-real-ip": client },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const leaving = (method: "GET" | "POST", id: string) =>
  unsubscribe[method](
    new Request(`https://example.com/api/unsubscribe/${id}`, {
      method,
      ...(method === "POST" ? { body: "List-Unsubscribe=One-Click" } : {}),
    }),
    { params: Promise.resolve({ contact: id }) },
  );
const setUp = () => {
  vi.stubEnv("RESEND_API_KEY", "key-1");
  vi.stubEnv("WAITLIST_FROM", "Example <hello@example.com>");
  const fine: Answer = { data: {}, error: null };
  for (const call of [resend.create, resend.get]) {
    call.mockResolvedValue({ data: { id: contact }, error: null });
  }
  resend.list.mockResolvedValue({ data: { data: [] }, error: null });
  for (const call of [resend.remove, resend.add, resend.leave, resend.send]) {
    call.mockResolvedValue(fine);
  }
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  resend.keys.length = 0;
});

describe("POST /api/waitlist", () => {
  it("keeps the address with Resend and sends the confirmation", async () => {
    setUp();
    vi.stubEnv("RESEND_SEGMENT_ID", "segment-1");
    const response = await join({ email: "  someone@example.com " });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(resend.keys).toEqual(["key-1"]);
    expect(resend.create).toHaveBeenCalledWith({
      email: "someone@example.com",
      segments: [{ id: "segment-1" }],
    });
    expect(resend.send).toHaveBeenCalledWith({
      from: "Example <hello@example.com>",
      to: "someone@example.com",
      subject: "Subject",
      html: `<p>${contact}</p>`,
      text: contact,
      headers: { "List-Unsubscribe": `<https://example.com/${contact}>` },
    });
  });

  it("answers an address already on the list the same, without an email", async () => {
    setUp();
    resend.create.mockResolvedValueOnce(down);
    const response = await join({ email: "someone@example.com" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(resend.send).not.toHaveBeenCalled();
  });

  it("refuses what is no email address", async () => {
    setUp();
    for (const body of [{ email: "nope" }, {}, { email: 5 }, "hello", null]) {
      expect((await join(body)).status).toBe(400);
    }
    expect(resend.create).not.toHaveBeenCalled();
  });

  it("keeps nothing when the hidden field is filled in", async () => {
    setUp();
    const response = await join({
      email: "someone@example.com",
      company: "Example",
    });
    expect(response.status).toBe(200);
    expect(resend.create).not.toHaveBeenCalled();
  });

  it("says it is not set up without a key or a sender", async () => {
    vi.stubEnv("RESEND_API_KEY", "key-1");
    vi.stubEnv("WAITLIST_FROM", "");
    const response = await join({ email: "someone@example.com" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not-set-up" });
    expect(resend.create).not.toHaveBeenCalled();
  });

  it("lets one client join five times in ten minutes, and no more", async () => {
    setUp();
    const from = (client: string) =>
      join({ email: "someone@example.com" }, client);
    for (let joins = 0; joins < 5; joins++) {
      expect((await from("one")).status).toBe(200);
    }
    const refused = await from("one");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "too-many" });
    expect(resend.create).toHaveBeenCalledTimes(5);
    expect((await from("another")).status).toBe(200);
  });

  it("says so when Resend kept no address", async () => {
    setUp();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    resend.create.mockResolvedValueOnce(down);
    resend.get.mockResolvedValueOnce(down);
    const response = await join({ email: "someone@example.com" });
    expect(response.status).toBe(502);
    expect(resend.send).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("/api/unsubscribe/<contact>", () => {
  it("takes the contact off the list when posted to, and answers nothing", async () => {
    setUp();
    const response = await leaving("POST", contact);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(resend.remove).toHaveBeenCalledWith({ id: contact });
  });

  it("takes a contact in other segments out of the waitlist's only", async () => {
    setUp();
    vi.stubEnv("RESEND_SEGMENT_ID", "segment-1");
    resend.list.mockResolvedValue({
      data: { data: [{ id: "segment-1" }, { id: "segment-2" }] },
      error: null,
    });
    expect((await leaving("POST", contact)).status).toBe(200);
    expect(resend.leave).toHaveBeenCalledWith({
      contactId: contact,
      segmentId: "segment-1",
    });
    expect(resend.remove).not.toHaveBeenCalled();
  });

  it("changes nothing when opened, and leads to the page for leaving", async () => {
    setUp();
    const response = await leaving("GET", contact);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/unsubscribe/${contact}`);
    expect(resend.remove).not.toHaveBeenCalled();
  });

  it("knows no contact by another kind of name", async () => {
    setUp();
    for (const method of ["GET", "POST"] as const) {
      expect((await leaving(method, "someone")).status).toBe(404);
    }
    expect(resend.remove).not.toHaveBeenCalled();
  });

  it("says it is not set up without a key", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    expect((await leaving("POST", contact)).status).toBe(503);
  });

  it("says so when Resend kept the contact", async () => {
    setUp();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    resend.remove.mockResolvedValueOnce(down);
    expect((await leaving("POST", contact)).status).toBe(502);
    log.mockRestore();
  });
});
