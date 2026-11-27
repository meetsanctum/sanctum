import {
  keyStretching,
  verifyPasswordChangeBinding,
} from "@meetsanctum/auth-protocol";
import { client } from "@serenity-kit/opaque";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  changePassword,
  choosePassword,
  PasswordChangeError,
} from "../src/auth/password";
import { selectHost } from "../src/auth/session";
import { CoreError, forgetToken, setCredential } from "../src/core-fetch";
import { setCoreBaseUrl } from "../src/core-url";
import { getShell } from "../src/shell";
import { deferred } from "./deferred";

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
const started = () =>
  Response.json({
    changeId: "change",
    loginResponse: "login-response",
    registrationResponse: "registration-response",
  });

beforeEach(() => {
  vi.stubGlobal("fetch", fetchResponse);
  vi.spyOn(getShell(), "trust", "get").mockReturnValue({
    check: vi.fn(),
    resumed: vi.fn(),
    candidate: vi.fn(),
    failure: vi.fn(),
  });
  selectHost(held);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  fetchResponse.mockReset();
  setCoreBaseUrl(null);
  setCredential(null);
});

const body = (call: number) =>
  JSON.parse(String(fetchResponse.mock.calls[call - 1]![1]?.body));

const passwords = { current: "old password", next: "new password" };

describe("changing your password on this device", () => {
  it("proves the current password and binds it to the held host and the new record", async () => {
    fetchResponse
      .mockResolvedValueOnce(started())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const attempt = new AbortController();
    await changePassword({ ...passwords, signal: attempt.signal });

    expect(client.startLogin).toHaveBeenCalledWith({
      password: "old password",
    });
    expect(client.finishLogin).toHaveBeenCalledWith({
      clientLoginState: "login-state",
      loginResponse: "login-response",
      password: "old password",
      keyStretching: keyStretching.profile,
    });
    expect(client.startRegistration).toHaveBeenCalledWith({
      password: "new password",
    });
    expect(client.finishRegistration).toHaveBeenCalledWith({
      clientRegistrationState: "registration-state",
      registrationResponse: "registration-response",
      password: "new password",
      keyStretching: keyStretching.profile,
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
    expect(finish).toEqual({
      changeId: "change",
      finishLoginRequest: "login-proof",
      binding: expect.any(String),
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

    const signals = fetchResponse.mock.calls.map(([, init]) => init?.signal);
    expect(signals.map((signal) => signal?.aborted)).toEqual([false, false]);
    attempt.abort();
    expect(signals.map((signal) => signal?.reason)).toEqual([
      attempt.signal.reason,
      attempt.signal.reason,
    ]);
  });

  it("stops on the device when the current password is wrong", async () => {
    vi.mocked(client.finishLogin).mockReturnValueOnce(undefined);
    fetchResponse.mockResolvedValueOnce(started());

    await expect(
      changePassword({ current: "wrong", next: "new password" }),
    ).rejects.toEqual(new PasswordChangeError("wrong_password"));
    expect(fetchResponse).toHaveBeenCalledOnce();
    expect(client.finishRegistration).not.toHaveBeenCalled();
  });

  it("waits for the finish response and reports a refusal", async () => {
    const sending = deferred<void>();
    const reply = deferred<Response>();
    fetchResponse
      .mockResolvedValueOnce(started())
      .mockImplementationOnce(() => {
        sending.resolve();
        return reply.promise;
      });
    const changing = changePassword(passwords);
    const settled = vi.fn();
    void changing.then(settled, settled);
    await sending.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();

    reply.resolve(Response.json({ error: "expired" }, { status: 400 }));
    await expect(changing).rejects.toEqual(
      new CoreError(400, "expired", {
        error: "expired",
      }),
    );
  });

  it.each(["start", "finish"] as const)(
    "sets a deadline on %s",
    async (phase) => {
      const deadline = new AbortController();
      const expired = new DOMException("Deadline reached", "TimeoutError");
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(deadline.signal);
      if (phase === "finish") fetchResponse.mockResolvedValueOnce(started());
      fetchResponse.mockImplementationOnce(async (_url, init) => {
        deadline.abort(expired);
        init?.signal?.throwIfAborted();
        return new Response(null, { status: 204 });
      });

      await expect(changePassword(passwords)).rejects.toEqual(
        phase === "start" ? expired : new PasswordChangeError("unconfirmed"),
      );
      expect(timeout).toHaveBeenCalledTimes(phase === "start" ? 1 : 2);
    },
  );

  it("reports that the change is unconfirmed when the finish reply is lost", async () => {
    fetchResponse
      .mockResolvedValueOnce(started())
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(changePassword(passwords)).rejects.toEqual(
      new PasswordChangeError("unconfirmed"),
    );
  });

  it("refuses to send a password change over HTTPS to an unpinned host", async () => {
    selectHost({ ...held, pin: null });

    await expect(changePassword(passwords)).rejects.toEqual(
      new PasswordChangeError("unchecked"),
    );
    expect(fetchResponse).not.toHaveBeenCalled();
  });

  it("changes it over plain HTTP in development, as signing in does", async () => {
    selectHost({ ...held, url: "http://home.example", pin: null });
    fetchResponse.mockImplementationOnce(async () => {
      throw new TypeError("offline");
    });

    await expect(changePassword(passwords)).rejects.toBeInstanceOf(TypeError);
    expect(String(fetchResponse.mock.calls[0]![0])).toBe(
      "http://home.example/api/auth/password/start",
    );
  });

  it("requires the shell to check the host's certificate", async () => {
    vi.spyOn(getShell(), "trust", "get").mockReturnValue(null);

    await expect(changePassword(passwords)).rejects.toEqual(
      new PasswordChangeError("unchecked"),
    );
    expect(fetchResponse).not.toHaveBeenCalled();
  });

  it("stops when the active credential is forgotten during the exchange", async () => {
    fetchResponse.mockImplementationOnce(async () => {
      forgetToken(held.token);
      return started();
    });
    await expect(changePassword(passwords)).rejects.toEqual(
      new PasswordChangeError("no_host"),
    );
    expect(fetchResponse).toHaveBeenCalledOnce();
    await expect(changePassword(passwords)).rejects.toEqual(
      new PasswordChangeError("no_host"),
    );
    expect(fetchResponse).toHaveBeenCalledOnce();
  });
});

describe("choosing a new password on this device", () => {
  it("registers the new one alone, with no current password", async () => {
    fetchResponse
      .mockResolvedValueOnce(
        Response.json({
          registrationId: "registration",
          registrationResponse: "registration-response",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await choosePassword({ next: "new password" });

    expect(client.startLogin).not.toHaveBeenCalled();
    expect(String(fetchResponse.mock.calls[0]![0])).toBe(
      `${url}/api/auth/password/choose/start`,
    );
    expect(body(1)).toEqual({ registrationRequest: "registration-request" });
    expect(String(fetchResponse.mock.calls[1]![0])).toBe(
      `${url}/api/auth/password/choose/finish`,
    );
    expect(body(2)).toEqual({
      registrationId: "registration",
      registrationRecord: "registration-record",
      keyStretching: keyStretching.version,
    });
  });

  it("refuses to send it over HTTPS to an unpinned host", async () => {
    selectHost({ ...held, pin: null });

    await expect(choosePassword({ next: "new password" })).rejects.toEqual(
      new PasswordChangeError("unchecked"),
    );
    expect(fetchResponse).not.toHaveBeenCalled();
  });
});
