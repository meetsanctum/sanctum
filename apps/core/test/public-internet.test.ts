import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { describe, expect, it } from "vitest";

import {
  isPublicAddress,
  publicInternet,
  publicOnly,
} from "../src/app-host/public-internet.js";

// The internet as apps reach it: public addresses only, checked as each
// connection is made, so neither a name nor an address in a URL reaches the
// home's network or the host itself.

// A lookup that answers with these addresses, as DNS would.
function answering(...addresses: string[]): LookupFunction {
  return (_hostname, options, callback) => {
    const found: LookupAddress[] = addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
    if (options.all) {
      callback(null, found);
    } else {
      callback(null, found[0]!.address, found[0]!.family);
    }
  };
}

function resolve(lookup: LookupFunction, isAll: boolean) {
  return new Promise<unknown>((done, fail) =>
    lookup("example.com", { all: isAll }, (error, address, family) =>
      error ? fail(error) : done(isAll ? address : { address, family }),
    ),
  );
}

describe("a public address", () => {
  it.each([
    "93.184.215.14",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "::ffff:93.184.215.14",
    "::ffff:5db8:d70e",
    "0:0:0:0:0:ffff:5db8:d70e",
  ])("is %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ["the host itself", "127.0.0.1"],
    ["the host itself over IPv6", "::1"],
    ["the home's network", "192.168.1.10"],
    ["another private network", "10.0.0.8"],
    ["a private network in 172.16/12", "172.20.1.1"],
    ["a carrier-grade NAT", "100.64.0.1"],
    ["a link-local address", "169.254.169.254"],
    ["an IPv6 link-local address", "fe80::1"],
    ["a unique local IPv6 address", "fd00::5"],
    ["the host itself written as IPv6", "::ffff:127.0.0.1"],
    ["the home's network written as IPv6 in hex", "::ffff:c0a8:10a"],
    ["site-local IPv6", "fec0::1"],
    ["NAT64 carrying a private address", "64:ff9b::c0a8:101"],
    ["IPv4-compatible loopback", "::127.0.0.1"],
    ["IPv6 documentation", "3fff::1"],
    ["IPv6 segment routing", "5f00::1"],
    ["a dummy IPv6 prefix", "100:0:0:1::1"],
    ["reserved IPv6 space", "4000::1"],
    ["no address at all", "0.0.0.0"],
    ["multicast", "224.0.0.251"],
    ["a name", "example.com"],
  ])("is never %s", (_case, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe("a lookup for apps' connections", () => {
  it("answers as asked when every address is public", async () => {
    const lookup = publicOnly(answering("93.184.215.14", "2606:4700::1"));

    expect(await resolve(lookup, false)).toEqual({
      address: "93.184.215.14",
      family: 4,
    });
    expect(await resolve(lookup, true)).toEqual([
      { address: "93.184.215.14", family: 4 },
      { address: "2606:4700::1", family: 6 },
    ]);
  });

  it("refuses a name with any address that is not public", async () => {
    const lookup = publicOnly(answering("93.184.215.14", "192.168.1.10"));

    await expect(resolve(lookup, false)).rejects.toMatchObject({
      code: "ENOTPUBLIC",
      message: "example.com is not on the public internet",
    });
  });

  it("passes on a lookup that fails", async () => {
    const lookup = publicOnly((_hostname, _options, callback) =>
      callback(
        Object.assign(new Error("not found"), { code: "ENOTFOUND" }),
        "",
        0,
      ),
    );

    await expect(resolve(lookup, true)).rejects.toMatchObject({
      code: "ENOTFOUND",
    });
  });

  it("keeps the core's fetch from connecting to a name on the host", async () => {
    const fetching = publicInternet()("https://localhost:8443/");

    await expect(fetching).rejects.toMatchObject({
      cause: { code: "ENOTPUBLIC" },
    });
  });
});
