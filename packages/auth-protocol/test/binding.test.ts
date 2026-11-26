import * as opaque from "@serenity-kit/opaque";
import { beforeAll, describe, expect, it } from "vitest";

import {
  newPairingSecret,
  pairingBinding,
  pairingConfirmation,
  pairingOpaque,
  passwordChangeBinding,
  signInBinding,
  signInConfirmation,
  verifyPasswordChangeBinding,
  verifySignInBinding,
  verifySignInConfirmation,
  verifyPairingBinding,
  verifyPairingConfirmation,
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

// A shared device's pairing runs OPAQUE the other way round: the device
// holds a one-time record of the secret it shows, and the host knows the
// secret once someone types it.
function pairingExchange(shown: string, typed: string) {
  const { identifiers, userIdentifier, keyStretching } = pairingOpaque;
  const serverSetup = opaque.server.createSetup();
  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password: shown });
  const { registrationResponse } = opaque.server.createRegistrationResponse({
    serverSetup,
    userIdentifier,
    registrationRequest,
  });
  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse,
    password: shown,
    identifiers,
    keyStretching,
  });
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
    password: typed,
  });
  const { serverLoginState, loginResponse } = opaque.server.startLogin({
    serverSetup,
    registrationRecord,
    startLoginRequest,
    userIdentifier,
    identifiers,
  });
  const host = opaque.client.finishLogin({
    clientLoginState,
    loginResponse,
    password: typed,
    identifiers,
    keyStretching,
  });
  if (!host) {
    return {};
  }
  const { sessionKey } = opaque.server.finishLogin({
    serverLoginState,
    finishLoginRequest: host.finishLoginRequest,
    identifiers,
  });
  return { device: sessionKey, host: host.sessionKey };
}

describe("the pairing exchange", () => {
  const ids = {
    requestId: "8f2a3a4e-1b6c-4c8e-9d7f-0a1b2c3d4e5f",
    exchangeId: "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5",
  };

  it("leaves the device and the host with one key when the typed code is the shown one", async () => {
    const secret = newPairingSecret();
    const keys = pairingExchange(secret, secret);

    expect(keys.device).toBe(keys.host);
    const binding = await pairingBinding(keys.device!, host, ids);
    expect(await verifyPairingBinding(keys.host!, host, ids, binding)).toBe(
      true,
    );
    const confirmation = await pairingConfirmation(
      keys.host!,
      host,
      ids,
      "client_token",
    );
    expect(
      await verifyPairingConfirmation(
        keys.device!,
        host,
        ids,
        "client_token",
        confirmation,
      ),
    ).toBe(true);
  });

  it("can't be finished with another code", () => {
    expect(pairingExchange("K7QXM4", "K7QXM5").host).toBeUndefined();
  });

  it("binds the view, the request and the exchange", async () => {
    const secret = newPairingSecret();
    const keys = pairingExchange(secret, secret);
    const binding = await pairingBinding(keys.device!, host, ids);

    for (const [view, bound] of [
      [{ ...host, pin: "aW50ZXJjZXB0b3I" }, ids],
      [host, { ...ids, exchangeId: "another-exchange" }],
      [host, { ...ids, requestId: "another-request" }],
    ] as const) {
      expect(await verifyPairingBinding(keys.host!, view, bound, binding)).toBe(
        false,
      );
    }
  });

  it("keeps its MACs apart from sign-in's and from each other", async () => {
    const secret = newPairingSecret();
    const keys = pairingExchange(secret, secret);

    const signIn = await signInBinding(keys.device!, host);
    expect(await verifyPairingBinding(keys.host!, host, ids, signIn)).toBe(
      false,
    );
    const binding = await pairingBinding(keys.device!, host, ids);
    expect(await verifySignInBinding(keys.host!, host, binding)).toBe(false);
    const confirmation = await pairingConfirmation(keys.host!, host, ids, "");
    expect(
      await verifyPairingBinding(keys.host!, host, ids, confirmation),
    ).toBe(false);
  });
});
