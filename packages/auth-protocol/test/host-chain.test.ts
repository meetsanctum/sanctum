import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";

import { checkHostChain, pinOf, presentedAnchor } from "../src/host-chain.js";
import { testCa } from "./certificates.js";

const dayMs = 24 * 60 * 60_000;

async function anchorOf(ca: { pem: string }) {
  return {
    pin: await pinOf(new X509Certificate(ca.pem)),
    caCertificate: ca.pem,
  };
}

describe("a host's chain", () => {
  it("passes when the pinned CA signed the server's certificate", async () => {
    const ca = await testCa();
    const chain = [await ca.leaf(), ca.pem];
    expect(await checkHostChain(chain, await anchorOf(ca))).toBe(ca.pem);
    // A host that sends only its own certificate: the stored CA is the anchor.
    expect(await checkHostChain([chain[0]!], await anchorOf(ca))).toBe(ca.pem);
  });

  it("fails for another CA, whatever the system thinks of it", async () => {
    const ca = await testCa();
    const other = await testCa();
    const chain = [await other.leaf(), other.pem];
    expect(await checkHostChain(chain, await anchorOf(ca))).toBeUndefined();
    // Another CA's certificate cannot stand in for the pinned one either.
    expect(
      await checkHostChain([await other.leaf(), ca.pem], await anchorOf(ca)),
    ).toBeUndefined();
  });

  it.each([
    ["has expired", { notAfter: Date.now() - dayMs }],
    ["has not started", { notBefore: Date.now() + dayMs }],
    ["is not for a server", { serverAuth: false }],
    ["is a CA itself", { ca: true }],
  ])("fails when the server's certificate %s", async (_name, options) => {
    const ca = await testCa();
    const chain = [await ca.leaf(options), ca.pem];
    expect(await checkHostChain(chain, await anchorOf(ca))).toBeUndefined();
    expect(await presentedAnchor(chain)).toBeUndefined();
  });

  it("fails when the CA's certificate is not valid now, unless the host sends it re-signed", async () => {
    const expired = await testCa({
      notBefore: Date.now() - 400 * dayMs,
      notAfter: Date.now() - dayMs,
    });
    const leaf = await expired.leaf({ notBefore: Date.now() - dayMs });
    expect(
      await checkHostChain([leaf, expired.pem], await anchorOf(expired)),
    ).toBeUndefined();

    // The same key with new dates: checked, it replaces the stored one.
    const reissued = await expired.reissue({});
    expect(
      await checkHostChain([leaf, reissued.pem], await anchorOf(expired)),
    ).toBe(reissued.pem);
  });

  it("fails when the CA's certificate is not a CA", async () => {
    const notCa = await testCa({ ca: false });
    const chain = [await notCa.leaf(), notCa.pem];
    expect(await checkHostChain(chain, await anchorOf(notCa))).toBeUndefined();
    expect(await presentedAnchor(chain)).toBeUndefined();
  });

  it("presents its CA at first contact", async () => {
    const ca = await testCa();
    expect(await presentedAnchor([await ca.leaf(), ca.pem])).toEqual(
      await anchorOf(ca),
    );
    // Without the CA in the chain, there is nothing to hold as a candidate.
    expect(await presentedAnchor([await ca.leaf()])).toBeUndefined();
    expect(await presentedAnchor(["not a certificate"])).toBeUndefined();
  });
});
