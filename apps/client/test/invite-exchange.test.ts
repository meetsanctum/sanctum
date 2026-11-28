import {
  inviteCheckBinding,
  inviteConfirmation,
  inviteFinishBinding,
  keyStretching,
  pairingCodeAlphabet,
  recoveryLookup,
} from "@meetsanctum/auth-protocol";
import { client } from "@serenity-kit/opaque";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkInviteCode, finishJoin } from "../src/auth/join";
import { setCredential } from "../src/core-fetch";
import { setCoreBaseUrl } from "../src/core-url";
import { makeInvite } from "../src/people/invites";

vi.mock("@serenity-kit/opaque", () => ({
  ready: Promise.resolve(),
  client: {
    startLogin: vi.fn(() => ({
      clientLoginState: "login-state",
      startLoginRequest: "login-request",
    })),
    finishLogin: vi.fn(() => ({
      finishLoginRequest: "login-proof",
      sessionKey: "dGVzdC1zZXNzaW9uLWtleQ",
    })),
    startRegistration: vi.fn(() => ({
      clientRegistrationState: "registration-state",
      registrationRequest: "registration-request",
    })),
    finishRegistration: vi.fn(() => ({
      registrationRecord: "registration-record",
    })),
  },
}));

const url = "https://home.example";
const host = { hostId: "host", homeId: "home", pin: "home-pin" };
const person = { id: "sam", name: "Sam", colour: "#fcd2b3", avatar: null };
const sessionKey = "dGVzdC1zZXNzaW9uLWtleQ";
const fetchResponse = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchResponse);
  setCoreBaseUrl("https://saved.example");
  setCredential({ ...host, url, token: "stored-token", pin: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  fetchResponse.mockReset();
  setCoreBaseUrl(null);
  setCredential(null);
});

function expectRequest(
  call: number,
  path: string,
  body: object,
  signal: AbortSignal,
  authorization: string | null = null,
) {
  const [address, init] = fetchResponse.mock.calls[call - 1]!;
  expect(String(address)).toBe(`${url}/api/auth/invites/${path}`);
  expect(init).toMatchObject({ method: "POST", signal });
  expect(new Headers(init?.headers).get("authorization")).toBe(authorization);
  expect(JSON.parse(String(init?.body))).toEqual(body);
}

describe("the client invite exchange", () => {
  it.each(["invite", "recovery"] as const)(
    "registers a %s code with the correct lookup and secret",
    async (kind) => {
      setCoreBaseUrl(url);
      const signal = new AbortController().signal;
      const info = {
        id: "invite-id",
        personId: person.id,
        kind,
        createdAt: "2026-11-26T10:00:00Z",
        endsAt: kind === "recovery" ? null : "2026-11-27T10:00:00Z",
        ended: null,
      };
      fetchResponse
        .mockImplementationOnce(async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          return Response.json({
            registrationId: "issued-id",
            registrationResponse: "registration-response",
            lookup: body.lookup ?? "K7",
          });
        })
        .mockResolvedValueOnce(Response.json(info));

      const made = await makeInvite({ personId: person.id, kind }, signal);
      const secret = vi.mocked(client.startRegistration).mock.calls[0]![0]
        .password;
      const recovery = kind === "recovery";
      expect(secret).toMatch(
        new RegExp(`^[${pairingCodeAlphabet}]{${recovery ? 16 : 6}}$`),
      );
      expect(client.finishRegistration).toHaveBeenCalledWith({
        clientRegistrationState: "registration-state",
        registrationResponse: "registration-response",
        password: secret,
        keyStretching: keyStretching.profile,
      });
      expect(made).toEqual({ code: recovery ? secret : `K7${secret}`, info });
      expect(fetchResponse).toHaveBeenCalledTimes(2);
      expectRequest(
        1,
        "start",
        {
          personId: person.id,
          kind,
          ...(recovery ? { lookup: await recoveryLookup(secret) } : {}),
          registrationRequest: "registration-request",
        },
        signal,
        "Bearer stored-token",
      );
      expectRequest(
        2,
        "finish",
        {
          registrationId: "issued-id",
          registrationRecord: "registration-record",
          keyStretching: keyStretching.version,
        },
        signal,
        "Bearer stored-token",
      );
    },
  );

  it.each([
    { typed: "k7qx-m4pd", secret: "QXM4PD", valid: true },
    { typed: "k7qx-m4pd", secret: "QXM4PD", valid: false },
    { typed: "k7qx-m4pd-w8rt-v2zn", secret: "K7QXM4PDW8RTV2ZN", valid: true },
  ])(
    "redeems $typed at the chosen home and verifies its confirmation ($valid)",
    async ({ typed, secret, valid }) => {
      const signal = new AbortController().signal;
      const token = "issued-token";
      const joined = {
        token,
        confirmation: await inviteConfirmation(
          sessionKey,
          host,
          valid ? token : "different-token",
        ),
        client: { id: "macbook", kind: "personal" },
        person,
      };
      fetchResponse
        .mockResolvedValueOnce(
          Response.json({
            redeemId: "proof-id",
            loginResponse: "login-response",
            keyStretching: keyStretching.version,
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ redeemId: "choose-id", person, username: null }),
        )
        .mockResolvedValueOnce(
          Response.json({
            username: "sam",
            registrationResponse: "registration-response",
          }),
        )
        .mockResolvedValueOnce(Response.json(joined));

      const code = await checkInviteCode({
        url,
        signal,
        code: typed,
        host,
      });
      const device = { name: "Sam’s Mac", platform: "macos" } as const;
      const result = finishJoin({
        url,
        signal,
        code,
        username: " Sam ",
        password: "a new password",
        client: device,
      });
      if (valid) {
        await expect(result).resolves.toEqual(joined);
      } else {
        await expect(result).rejects.toMatchObject({ code: "unconfirmed" });
      }
      expect(client.startLogin).toHaveBeenCalledWith({ password: secret });
      expect(fetchResponse).toHaveBeenCalledTimes(4);
      expectRequest(
        1,
        "redeem/start",
        {
          lookup: secret.length === 6 ? "K7" : await recoveryLookup(secret),
          startLoginRequest: "login-request",
        },
        signal,
      );
      expectRequest(
        2,
        "redeem/check",
        {
          redeemId: "proof-id",
          finishLoginRequest: "login-proof",
          binding: await inviteCheckBinding(sessionKey, host),
        },
        signal,
      );
      expectRequest(
        3,
        "redeem/register",
        {
          redeemId: "choose-id",
          username: "sam",
          registrationRequest: "registration-request",
        },
        signal,
      );
      expectRequest(
        4,
        "redeem/finish",
        {
          redeemId: "choose-id",
          registrationRecord: "registration-record",
          keyStretching: keyStretching.version,
          binding: await inviteFinishBinding(
            sessionKey,
            host,
            "sam",
            "registration-record",
          ),
          client: device,
        },
        signal,
      );
    },
  );
});
