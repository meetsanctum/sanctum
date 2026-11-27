import {
  keyStretching,
  verifyPasswordChangeBinding,
} from "@meetsanctum/auth-protocol";
import { client } from "@serenity-kit/opaque";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { changePassword, PasswordChangeError } from "../src/auth/password";
import { selectHost } from "../src/auth/session";
import { setCredential } from "../src/core-fetch";
import { setCoreBaseUrl } from "../src/core-url";

// Changing your own password on the device: the current password is proven
// and the new one registered in two calls, the proof bound to the host this
// device holds and to the new record; a wrong current password stops on the
// device after the first.

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
const held = {
  hostId: "host",
  homeId: "home",
  name: "Office",
  url,
  clientId: "laptop",
  token: "stored-token",
  kind: "personal" as const,
  pin: "home-pin",
};
const fetchResponse = vi.fn<typeof fetch>();

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.stubGlobal("fetch", fetchResponse);
  selectHost(held);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  fetchResponse.mockReset();
  setCoreBaseUrl(null);
  setCredential(null);
});

const body = (call: number) =>
  JSON.parse(String(fetchResponse.mock.calls[call - 1]![1]?.body));

describe("changing your password on this device", () => {
  it("proves the current password and binds it to the held host and the new record", async () => {
    fetchResponse
      .mockResolvedValueOnce(
        json({
          changeId: "change",
          loginResponse: "login-response",
          registrationResponse: "registration-response",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await changePassword({ current: "old password", next: "new password" });

    expect(client.startLogin).toHaveBeenCalledWith({
      password: "old password",
    });
    expect(client.startRegistration).toHaveBeenCalledWith({
      password: "new password",
    });
    expect(String(fetchResponse.mock.calls[0]![0])).toBe(
      `${url}/api/auth/password/start`,
    );
    expect(body(1)).toEqual({
      startLoginRequest: "login-request",
      registrationRequest: "registration-request",
    });
    expect(String(fetchResponse.mock.calls[1]![0])).toBe(
      `${url}/api/auth/password/finish`,
    );
    const finish = body(2);
    expect(finish).toMatchObject({
      changeId: "change",
      finishLoginRequest: "login-proof",
      registrationRecord: "registration-record",
      keyStretching: keyStretching.version,
    });
    expect(
      await verifyPasswordChangeBinding(
        "dGVzdC1zZXNzaW9uLWtleQ",
        { hostId: "host", homeId: "home", pin: "home-pin" },
        "registration-record",
        finish.binding,
      ),
    ).toBe(true);
    expect(
      new Headers(fetchResponse.mock.calls[1]![1]?.headers).get(
        "authorization",
      ),
    ).toBe("Bearer stored-token");
  });

  it("stops on the device when the current password is wrong", async () => {
    vi.mocked(client.finishLogin).mockReturnValueOnce(undefined);
    fetchResponse.mockResolvedValueOnce(
      json({
        changeId: "change",
        loginResponse: "login-response",
        registrationResponse: "registration-response",
      }),
    );

    await expect(
      changePassword({ current: "wrong", next: "new password" }),
    ).rejects.toEqual(new PasswordChangeError("wrong_password"));
    expect(fetchResponse).toHaveBeenCalledOnce();
    expect(client.finishRegistration).not.toHaveBeenCalled();
  });
});
