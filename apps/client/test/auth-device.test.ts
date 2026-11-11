import { signInConfirmation } from "@meetsanctum/auth-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkHost, claimHost, signIn, SignInError } from "../src/auth/device";
import { getShell, type Shell } from "../src/shell";
import { setCoreBaseUrl } from "../src/core-url";

// The exchanges below exercise routing and cancellation; OPAQUE itself is
// covered by the core's end-to-end authentication tests.
vi.mock("@serenity-kit/opaque", () => ({
  ready: Promise.resolve(),
  client: {
    startRegistration: () => ({
      clientRegistrationState: "state",
      registrationRequest: "request",
    }),
    finishRegistration: () => ({ registrationRecord: "record" }),
    startLogin: () => ({
      clientLoginState: "state",
      startLoginRequest: "request",
    }),
    finishLogin: () => ({
      finishLoginRequest: "finish",
      sessionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }),
  },
}));

const url = "http://192.168.1.20:4100";
const otherUrl = "http://192.168.1.21:4100";
const input = {
  url,
  hostId: "host-id",
  homeId: "home-id",
  pin: null,
  username: "maya",
  password: "a password",
  person: { name: "Maya", colour: "#c5cdac" },
  client: { name: "Laptop", platform: "macos" as const },
};

afterEach(() => {
  vi.restoreAllMocks();
  setCoreBaseUrl(null);
});

describe("the device's authentication exchange", () => {
  it.each(["claim", "sign-in"])(
    "keeps %s on the chosen host if the selected home changes",
    async (kind) => {
      const confirmation = await signInConfirmation(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        { hostId: input.hostId, homeId: input.homeId, pin: null },
        "client_new",
      );
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (target) => {
          // The person chose another home while this exchange was in flight.
          setCoreBaseUrl(otherUrl);
          return Response.json(
            String(target).endsWith("/start")
              ? {
                  registrationId: "r1",
                  registrationResponse: "response",
                  signInId: "s1",
                  loginResponse: "response",
                }
              : { token: "client_new", confirmation },
          );
        });
      setCoreBaseUrl(url);

      await (kind === "claim" ? claimHost(input) : signIn(input));

      expect(fetch.mock.calls.map(([target]) => String(target))).toEqual([
        `${url}/api/auth/${kind}/start`,
        `${url}/api/auth/${kind}/finish`,
      ]);
      for (const [, init] of fetch.mock.calls) {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
      }
    },
  );

  it.each([claimHost, signIn])(
    "does not start an exchange that was cancelled while loading OPAQUE",
    async (exchange) => {
      const fetch = vi.spyOn(globalThis, "fetch");
      const controller = new AbortController();
      const pending = exchange({ ...input, signal: controller.signal });
      controller.abort();

      await expect(pending).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("checks the chosen address before sign-in", async () => {
    setCoreBaseUrl(otherUrl);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        hostId: input.hostId,
        homeId: input.homeId,
        claimed: true,
      }),
    );
    expect(await checkHost({ id: input.hostId, homeId: null, url })).toEqual({
      pin: null,
      homeId: input.homeId,
    });
    expect(String(fetch.mock.calls[0]![0])).toBe(`${url}/api/auth/status`);
  });

  it("refuses another home where the chosen one was found", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        hostId: input.hostId,
        homeId: "another-home",
        claimed: true,
      }),
    );
    await expect(
      checkHost({ id: input.hostId, homeId: input.homeId, url }),
    ).rejects.toEqual(new SignInError("another_host"));
    await expect(
      checkHost({ id: "another-host", homeId: null, url }),
    ).rejects.toEqual(new SignInError("another_host"));
  });

  it("binds the sign-in to the pin of the certificate the shell saw", async () => {
    const pin = "hg6mmQxxksnFQb7m8qDqK0hT9z6lRb6vS8aW2b0FbUQ";
    const calls: string[] = [];
    const trust: NonNullable<Shell["trust"]> = {
      check: async (hostId) => void calls.push(`check ${hostId}`),
      candidate: async () => (calls.push("candidate"), pin),
      failure: async () => null,
      resumed: async () => null,
    };
    vi.spyOn(getShell(), "trust", "get").mockReturnValue(trust);
    const sessionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const confirmation = await signInConfirmation(
      sessionKey,
      { hostId: input.hostId, homeId: input.homeId, pin },
      "client_new",
    );
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (target, init) => {
      calls.push(new URL(String(target)).pathname);
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return Response.json(
        String(target).endsWith("/status")
          ? { hostId: input.hostId, homeId: input.homeId, claimed: true }
          : String(target).endsWith("/start")
            ? { signInId: "s1", loginResponse: "response" }
            : { token: "client_new", confirmation },
      );
    });
    const https = "https://192.168.1.20:4100";

    const seen = await checkHost({
      id: input.hostId,
      homeId: input.homeId,
      url: https,
    });
    expect(seen).toEqual({ pin, homeId: input.homeId });
    expect(calls).toEqual([
      `check ${input.hostId}`,
      "/api/auth/status",
      "candidate",
    ]);
    // A host that bound another pin does not confirm, so nothing is saved.
    await expect(signIn({ ...input, url: https, pin: null })).rejects.toEqual(
      new SignInError("unconfirmed"),
    );
    const signedIn = await signIn({ ...input, url: https, ...seen });
    expect(signedIn.token).toBe("client_new");
    const { signInBinding } = await import("@meetsanctum/auth-protocol");
    expect(bodies.at(-1)).toMatchObject({
      binding: await signInBinding(sessionKey, {
        hostId: input.hostId,
        homeId: input.homeId,
        pin,
      }),
    });
  });

  it("refuses a host over HTTPS where nothing checks its certificate", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        hostId: input.hostId,
        homeId: input.homeId,
        claimed: true,
      }),
    );
    await expect(
      checkHost({
        id: input.hostId,
        homeId: input.homeId,
        url: "https://192.168.1.20:4100",
      }),
    ).rejects.toEqual(new SignInError("unchecked"));
  });
});
