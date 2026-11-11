import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CoreError,
  coreFetch,
  coreJson,
  currentCredential,
  onTokenInvalid,
  setCredential,
} from "../src/core-fetch";
import { setCoreBaseUrl } from "../src/core-url";

const host = "http://192.168.1.20:4100";
const token = "client_maya";

function respond(body: unknown, status = 200) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json(body, { status }));
}

function sent(fetch: ReturnType<typeof respond>, call = 0) {
  const [url, init] = fetch.mock.calls[call]!;
  return { url: String(url), init: init!, headers: new Headers(init!.headers) };
}

beforeEach(() => {
  setCoreBaseUrl(host);
  setCredential({ url: host, token, pin: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  setCoreBaseUrl(null);
  setCredential(null);
});

describe("coreFetch", () => {
  it("adds the token to the stored core's requests and refuses redirects", async () => {
    const fetch = respond({ ok: true });

    await coreFetch("/api/auth/me");

    const { url, init, headers } = sent(fetch);
    expect(url).toBe(`${host}/api/auth/me`);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
  });

  it("takes only core-relative paths", async () => {
    const fetch = respond({});

    for (const path of [
      "https://example.com/api/x",
      "//example.com/api/x",
      "/health",
      "api/x",
    ]) {
      await expect(coreFetch(path)).rejects.toThrow(TypeError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends no token to another core, at first contact or to a candidate address", async () => {
    const fetch = respond({});

    setCoreBaseUrl("http://192.168.1.30:4100");
    await coreFetch("/api/auth/status");
    setCoreBaseUrl(host);
    await coreFetch("/api/auth/sign-in/start", {
      method: "POST",
      omitToken: true,
    });
    await coreFetch("/api/auth/status", { at: "http://192.168.1.21:4100" });
    // A component's own header never gets through.
    await coreFetch("/api/auth/status", {
      omitToken: true,
      headers: { authorization: "Bearer client_other" },
    });

    for (let call = 0; call < 4; call += 1) {
      expect(sent(fetch, call).headers.has("authorization")).toBe(false);
    }
    expect(sent(fetch, 2).url).toBe("http://192.168.1.21:4100/api/auth/status");
  });

  it("names the app whose page asks", async () => {
    const fetch = respond({});

    await coreFetch("/api/places", { app: "sanctum.moods" });
    await coreFetch("/api/places");

    expect(sent(fetch).headers.get("x-sanctum-app")).toBe("sanctum.moods");
    // The shell's own requests name none.
    expect(sent(fetch, 1).headers.has("x-sanctum-app")).toBe(false);
  });

  it("sends JSON bodies", async () => {
    const fetch = respond({});

    await coreFetch("/api/auth/clients/rename", {
      method: "POST",
      json: { id: "c1", name: "Laptop" },
    });

    const { init, headers } = sent(fetch);
    expect(headers.get("content-type")).toBe("application/json");
    expect(init.body).toBe('{"id":"c1","name":"Laptop"}');
  });

  it("forgets the token when the core reports that token invalid", async () => {
    respond({ error: "invalid_client_token" }, 401);
    const removed: string[] = [];
    const stop = onTokenInvalid((invalid) => removed.push(invalid));

    const response = await coreFetch("/api/auth/me");

    expect(response.status).toBe(401);
    expect(removed).toEqual([token]);
    expect(currentCredential()).toBeNull();
    stop();
  });

  it("keeps the token for any other refusal", async () => {
    const removed: string[] = [];
    const stop = onTokenInvalid((invalid) => removed.push(invalid));

    respond({ error: "sign_in_failed" }, 401);
    await coreFetch("/api/auth/me");
    vi.restoreAllMocks();
    respond({ error: "forbidden" }, 403);
    await coreFetch("/api/auth/me");
    vi.restoreAllMocks();
    // A first-contact refusal carried no token, so says nothing about it.
    respond({ error: "invalid_client_token" }, 401);
    await coreFetch("/api/auth/status", { omitToken: true });

    expect(removed).toEqual([]);
    expect(currentCredential()).toEqual({ url: host, token, pin: null });
    stop();
  });

  it("forgets only the token the refused request carried", async () => {
    let answer!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const removed: string[] = [];
    const stop = onTokenInvalid((invalid) => removed.push(invalid));

    const pending = coreFetch("/api/auth/me");
    // Signed in again meanwhile.
    setCredential({ url: host, token: "client_new", pin: null });
    answer(Response.json({ error: "invalid_client_token" }, { status: 401 }));
    await pending;

    expect(removed).toEqual([]);
    expect(currentCredential()?.token).toBe("client_new");
    stop();
  });
});

describe("coreJson", () => {
  it("throws the core's error code", async () => {
    respond({ error: "too_many_attempts" }, 429);

    await expect(coreJson("/api/auth/sign-in/start")).rejects.toMatchObject({
      status: 429,
      code: "too_many_attempts",
    });
    await expect(coreJson("/api/auth/sign-in/start")).rejects.toBeInstanceOf(
      CoreError,
    );
  });
});
