import * as opaque from "@serenity-kit/opaque";
import { beforeAll, describe, expect, it } from "vitest";

import {
  passwordChangeBinding,
  signInBinding,
  signInConfirmation,
  verifyPasswordChangeBinding,
  verifySignInBinding,
  verifySignInConfirmation,
} from "../src/index.js";

const fast = {
  "argon2id-custom": { iterations: 1, memory: 1024, parallelism: 1 },
} as const;
const host = {
  hostId: "6b0f6f4e-2a52-4f8e-9a51-1d1d1f6e6e73",
  homeId: "0d5c1f0a-7a43-4b6e-8f0e-2f6a0c9b1e55",
  pin: null,
};

beforeAll(() => opaque.ready);

function register(serverSetup: string, password: string) {
  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password });
  const { registrationResponse } = opaque.server.createRegistrationResponse({
    serverSetup,
    userIdentifier: "maya",
    registrationRequest,
  });
  return opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse,
    password,
    keyStretching: fast,
  }).registrationRecord;
}

// Both sides' session keys after a sign-in, or none for the device when it
// cannot finish.
function signIn(serverSetup: string, record: string | null, password: string) {
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
    password,
  });
  const { serverLoginState, loginResponse } = opaque.server.startLogin({
    serverSetup,
    registrationRecord: record,
    startLoginRequest,
    userIdentifier: "maya",
  });
  const device = opaque.client.finishLogin({
    clientLoginState,
    loginResponse,
    password,
    keyStretching: fast,
  });
  if (!device) {
    return {};
  }
  const { sessionKey } = opaque.server.finishLogin({
    serverLoginState,
    finishLoginRequest: device.finishLoginRequest,
  });
  return { device: device.sessionKey, host: sessionKey };
}

describe("the sign-in binding", () => {
  it("checks out when both sides see the same host", async () => {
    const setup = opaque.server.createSetup();
    const keys = signIn(
      setup,
      register(setup, "correct horse"),
      "correct horse",
    );

    const binding = await signInBinding(keys.device!, host);
    expect(await verifySignInBinding(keys.host!, host, binding)).toBe(true);
    const confirmation = await signInConfirmation(keys.host!, host, "client_x");
    expect(
      await verifySignInConfirmation(
        keys.device!,
        host,
        "client_x",
        confirmation,
      ),
    ).toBe(true);
  });

  it("fails when the device saw another host or certificate", async () => {
    const setup = opaque.server.createSetup();
    const keys = signIn(
      setup,
      register(setup, "correct horse"),
      "correct horse",
    );

    const elsewhere = await signInBinding(keys.device!, {
      ...host,
      hostId: "another-host",
    });
    const intercepted = await signInBinding(keys.device!, {
      ...host,
      pin: "interceptor",
    });
    const anotherHome = await signInBinding(keys.device!, {
      ...host,
      homeId: "another-home",
    });
    expect(await verifySignInBinding(keys.host!, host, elsewhere)).toBe(false);
    expect(await verifySignInBinding(keys.host!, host, anotherHome)).toBe(
      false,
    );
    expect(await verifySignInBinding(keys.host!, host, intercepted)).toBe(
      false,
    );
    expect(await verifySignInBinding(keys.host!, host, "not base64!")).toBe(
      false,
    );
  });

  it("does not let a confirmation pass for another token", async () => {
    const setup = opaque.server.createSetup();
    const keys = signIn(
      setup,
      register(setup, "correct horse"),
      "correct horse",
    );

    const confirmation = await signInConfirmation(keys.host!, host, "client_x");
    expect(
      await verifySignInConfirmation(
        keys.device!,
        host,
        "client_y",
        confirmation,
      ),
    ).toBe(false);
  });

  it("keeps each purpose's MAC to that purpose", async () => {
    const setup = opaque.server.createSetup();
    const keys = signIn(
      setup,
      register(setup, "correct horse"),
      "correct horse",
    );

    const binding = await signInBinding(keys.device!, host);
    const change = await passwordChangeBinding(keys.device!, host, "record");
    expect(
      await verifyPasswordChangeBinding(keys.host!, host, "record", binding),
    ).toBe(false);
    expect(
      await verifyPasswordChangeBinding(keys.host!, host, "record", change),
    ).toBe(true);
    expect(
      await verifyPasswordChangeBinding(keys.host!, host, "other", change),
    ).toBe(false);
  });

  it("cannot be finished by a host without the household's records", () => {
    const record = register(opaque.server.createSetup(), "correct horse");
    const fake = opaque.server.createSetup();

    expect(signIn(fake, null, "correct horse").device).toBeUndefined();
    expect(signIn(fake, record, "correct horse").device).toBeUndefined();
  });
});
