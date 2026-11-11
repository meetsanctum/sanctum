import { X509Certificate } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { pinOf } from "../src/host-chain.js";
import type { KeptHost, StoredHost } from "../src/shell.js";
import { accept, createHostTrust, refuse } from "../src/trust.js";
import { testCa, type TestCa } from "./certificates.js";

const hostId = "6b0f6f4e-2a52-4f8e-9a51-1d1d1f6e6e73";
const url = "https://192.168.1.20:4100";

// Credentials kept in memory.
function setUp(
  kept: KeptHost | null = null,
  beforeReplace = async () => {},
  beforeSave = async () => {},
) {
  const state = { kept };
  const trust = createHostTrust({
    credentials: {
      load: async () => state.kept,
      save: async (host) => {
        await beforeSave();
        state.kept = host;
      },
      forget: async (token) => {
        if (state.kept?.token === token) state.kept = null;
      },
      replaceCaCertificate: async (pin, caCertificate) => {
        await beforeReplace();
        if (state.kept?.pin === pin) {
          state.kept = { ...state.kept, caCertificate };
        }
      },
    },
  });
  return { trust, state };
}

const chainOf = async (ca: TestCa) => [await ca.leaf(), ca.pem];
const pin = (ca: TestCa) => pinOf(new X509Certificate(ca.pem));

async function storedHost(ca: TestCa): Promise<KeptHost> {
  return {
    hostId,
    homeId: "0d5c1f0a-7a43-4b6e-8f0e-2f6a0c9b1e55",
    name: "Sanctum",
    url,
    clientId: "c1",
    token: "client_secret",
    kind: "personal",
    pin: await pin(ca),
    caCertificate: ca.pem,
  };
}

function signedIn(host: Omit<StoredHost, "pin">, pinned: string): StoredHost {
  return { ...host, pin: pinned };
}

describe("a paired host", () => {
  it("is reached only with its pinned CA", async () => {
    const ca = await testCa();
    const { trust } = setUp(await storedHost(ca));
    await trust.start();

    expect(await trust.verify("192.168.1.20", await chainOf(ca))).toBe(accept);
    // At another address too: the pin says which host answered.
    expect(await trust.verify("192.168.1.21", await chainOf(ca))).toBe(accept);
  });

  it("is not whatever answers with another CA, which reads as a changed certificate", async () => {
    const ca = await testCa();
    const impostor = await testCa();
    const { trust } = setUp(await storedHost(ca));
    await trust.start();

    expect(await trust.verify("192.168.1.20", await chainOf(impostor))).toBe(
      refuse,
    );
    expect(trust.failure(url)).toBe("changed");
    expect(trust.failure("https://192.168.1.21:4100")).toBeNull();

    // An expired certificate from the right CA is no change of host.
    expect(
      await trust.verify("192.168.1.22", [
        await ca.leaf({ notAfter: Date.now() - 1_000 }),
        ca.pem,
      ]),
    ).toBe(refuse);
    expect(trust.failure("https://192.168.1.22:4100")).toBe("invalid");

    // Something that is no host at all, such as a server without its CA in
    // the chain, is neither.
    expect(await trust.verify("192.168.1.23", [await impostor.leaf()])).toBe(
      refuse,
    );
    expect(trust.failure("https://192.168.1.23:4100")).toBeNull();
  });

  it("keeps a re-signed CA certificate once it checks out", async () => {
    const ca = await testCa();
    const { trust, state } = setUp(await storedHost(ca));
    await trust.start();
    const reissued = await ca.reissue({});

    const leaf = await ca.leaf();
    const accepted = vi.fn();
    expect(
      await trust.verify("192.168.1.20", [leaf, reissued.pem], accepted),
    ).toBe(accept);
    expect(accepted).toHaveBeenCalledWith([leaf, reissued.pem], true);
    expect(state.kept?.caCertificate).toBe(reissued.pem);
    expect(state.kept?.pin).toBe(await pin(ca));
  });

  it("reports the stored anchor's dates when the server omits it", async () => {
    const ca = await testCa();
    const { trust } = setUp(await storedHost(ca));
    await trust.start();
    const leaf = await ca.leaf();
    const accepted = vi.fn();
    expect(await trust.verify("192.168.1.20", [leaf], accepted)).toBe(accept);
    expect(accepted).toHaveBeenCalledWith([leaf, ca.pem], true);
    const expired = await ca.leaf({ notAfter: Date.now() - 1_000 });
    const refused = vi.fn();
    expect(await trust.verify("192.168.1.20", [expired], refused)).toBe(refuse);
    expect(refused).toHaveBeenCalledWith([expired, ca.pem], false);
  });

  it("accepts concurrent connections during renewal of the same CA key", async () => {
    const ca = await testCa();
    const { trust } = setUp(await storedHost(ca));
    await trust.start();
    const reissued = await ca.reissue({});
    const chain = [await ca.leaf(), reissued.pem];
    expect(
      await Promise.all([
        trust.verify("192.168.1.20", chain),
        trust.verify("192.168.1.21", chain),
      ]),
    ).toEqual([accept, accept]);
  });

  it("refuses a verification whose trust changed while storing a renewed CA", async () => {
    const ca = await testCa();
    let finish!: () => void;
    const saving = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const beforeReplace = vi.fn(() => saving);
    const { trust } = setUp(await storedHost(ca), beforeReplace);
    await trust.start();
    const reissued = await ca.reissue({});
    const verifying = trust.verify("192.168.1.20", [
      await ca.leaf(),
      reissued.pem,
    ]);
    await vi.waitFor(() => expect(beforeReplace).toHaveBeenCalled());
    trust.check(hostId);
    finish();
    expect(await verifying).toBe(refuse);
  });

  it("checks every host as a host, public ones too", async () => {
    const { trust } = setUp();
    await trust.start();
    // The page's fonts ship with it, so no host is left to the system's
    // roots, and without a host nothing is reached.
    for (const host of ["fonts.gstatic.com", "example.com"]) {
      expect(await trust.verify(host, await chainOf(await testCa()))).toBe(
        refuse,
      );
    }
  });
});

describe("a first contact", () => {
  it("keeps an in-flight connection valid when its candidate becomes the pin", async () => {
    const ca = await testCa();
    const { trust } = setUp();
    await trust.start();
    trust.check(hostId);
    const chain = await chainOf(ca);
    await trust.verify("192.168.1.20", chain);
    const host = await storedHost(ca);
    const verifying = trust.verify("192.168.1.21", chain);
    await trust.save(host);
    expect(await verifying).toBe(accept);
  });

  it("holds the first CA it sees as the only candidate, and pins it when saved", async () => {
    const ca = await testCa();
    const other = await testCa();
    const { trust, state } = setUp();
    await trust.start();

    expect(trust.check(hostId)).toBe(true);
    expect(trust.isChecking()).toBe(true);
    expect(trust.candidate()).toBeNull();
    expect(await trust.verify("192.168.1.20", await chainOf(ca))).toBe(accept);
    expect(trust.candidate()).toBe(await pin(ca));
    expect(await trust.verify("192.168.1.20", await chainOf(other))).toBe(
      refuse,
    );

    await trust.save(
      signedIn(
        {
          hostId,
          homeId: "0d5c1f0a-7a43-4b6e-8f0e-2f6a0c9b1e55",
          name: "Sanctum",
          url,
          clientId: "c1",
          token: "client_new",
          kind: "personal",
        },
        await pin(ca),
      ),
    );
    expect(trust.isChecking()).toBe(false);
    expect(state.kept).toMatchObject({
      pin: await pin(ca),
      caCertificate: ca.pem,
    });
    expect(await trust.verify("192.168.1.20", await chainOf(ca))).toBe(accept);
  });

  it("pins nothing the page did not see", async () => {
    const ca = await testCa();
    const other = await testCa();
    const { trust } = setUp();
    await trust.start();
    await trust.check(hostId);
    await trust.verify("192.168.1.20", await chainOf(ca));

    const host = {
      hostId,
      homeId: "0d5c1f0a-7a43-4b6e-8f0e-2f6a0c9b1e55",
      name: "Sanctum",
      url,
      clientId: "c1",
      token: "client_new",
      kind: "personal" as const,
    };
    await expect(trust.save(signedIn(host, await pin(other)))).rejects.toThrow(
      /checked/,
    );
    await expect(
      trust.save(signedIn({ ...host, hostId: "another-host" }, await pin(ca))),
    ).rejects.toThrow(/checked/);
    await expect(trust.save({ ...host, pin: null })).rejects.toThrow(/pin/);
  });

  it("starts afresh after a changed certificate, and goes back to the pin when abandoned", async () => {
    const ca = await testCa();
    const restored = await testCa();
    const { trust } = setUp(await storedHost(ca));
    await trust.start();
    expect(await trust.verify("192.168.1.20", await chainOf(restored))).toBe(
      refuse,
    );

    // A change of trust: the page moves to a fresh session.
    expect(trust.check(hostId)).toBe(true);
    // Cleared with the change.
    expect(trust.failure(url)).toBeNull();
    expect(await trust.verify("192.168.1.20", await chainOf(restored))).toBe(
      accept,
    );
    // Asking again for the same host keeps its candidate.
    expect(trust.check(hostId)).toBe(false);
    expect(trust.candidate()).toBe(await pin(restored));

    expect(trust.check(null)).toBe(true);
    expect(trust.check(null)).toBe(false);
    expect(await trust.verify("192.168.1.20", await chainOf(restored))).toBe(
      refuse,
    );
    expect(await trust.verify("192.168.1.20", await chainOf(ca))).toBe(accept);
  });

  it("refuses a check that began under trust that has since changed", async () => {
    const ca = await testCa();
    const { trust } = setUp(await storedHost(ca));
    await trust.start();
    const chain = await chainOf(ca);
    const verifying = trust.verify("192.168.1.20", chain);
    trust.check(hostId);
    expect(await verifying).toBe(refuse);
  });

  it("does not pin a candidate after its first contact was abandoned during storage", async () => {
    const ca = await testCa();
    const replacement = await testCa();
    let finish!: () => void;
    const saving = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const beforeSave = vi.fn(() => saving);
    const { trust, state } = setUp(await storedHost(ca), undefined, beforeSave);
    await trust.start();
    trust.check(hostId);
    const chain = await chainOf(replacement);
    await trust.verify("192.168.1.20", chain);
    const saved = trust.save(await storedHost(replacement));
    const refused = expect(saved).rejects.toThrow(/changed/);
    expect(beforeSave).toHaveBeenCalled();
    trust.check(null);
    finish();
    await refused;
    expect(state.kept).toBeNull();
    expect(await trust.verify("192.168.1.20", chain)).toBe(refuse);
    expect(await trust.verify("192.168.1.20", await chainOf(ca))).toBe(accept);
  });
});

describe("forgetting the host", () => {
  it("drops its pin, only for the token it holds", async () => {
    const ca = await testCa();
    const { trust } = setUp(await storedHost(ca));
    await trust.start();

    expect(await trust.forget("client_older")).toBe(false);
    expect(await trust.verify("192.168.1.20", await chainOf(ca))).toBe(accept);
    // A change of trust: the page moves to a fresh session.
    expect(await trust.forget("client_secret")).toBe(true);
    expect(await trust.verify("192.168.1.20", await chainOf(ca))).toBe(refuse);
  });
});
