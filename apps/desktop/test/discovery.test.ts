import { describe, expect, it, vi } from "vitest";

import { hostList, foundHost, watchDevHost } from "../src/discovery.js";

const id = "6b0f6f4e-2a52-4f8e-9a51-1d1d1f6e6e73";
const homeId = "0d5c1f0a-7a43-4b6e-8f0e-2f6a0c9b1e55";

describe("a DNS-SD answer", () => {
  it("describes a host by its id, its home's, claimed flag and IPv4 address", () => {
    expect(
      foundHost({
        name: "Sanctum",
        port: 4100,
        txt: { id, home: homeId, claimed: "1" },
        addresses: ["fe80::1", "192.168.1.20"],
      }),
    ).toEqual({
      id,
      homeId,
      name: "Sanctum",
      claimed: true,
      url: "https://192.168.1.20:4100",
    });
  });

  it("has no home id from a host before home ids, or a malformed one", () => {
    for (const txt of [{ id }, { id, home: "x y" }]) {
      expect(
        foundHost({
          name: "Sanctum",
          port: 4100,
          txt,
          addresses: ["192.168.1.20"],
        }),
      ).toMatchObject({ id, homeId: null });
    }
  });

  it("falls back to the address the answer came from", () => {
    expect(
      foundHost({
        name: "Sanctum",
        port: 4100,
        txt: { id, claimed: "0" },
        addresses: [],
        referer: {
          address: "192.168.1.21",
          family: "IPv4",
          port: 5353,
          size: 0,
        },
      }),
    ).toMatchObject({ claimed: false, url: "https://192.168.1.21:4100" });
  });

  it("is no host without an id or an address", () => {
    expect(
      foundHost({
        name: "Sanctum",
        port: 4100,
        txt: {},
        addresses: ["192.168.1.20"],
      }),
    ).toBeUndefined();
    expect(
      foundHost({
        name: "Sanctum",
        port: 4100,
        txt: { id: "x y" },
        addresses: ["192.168.1.20"],
      }),
    ).toBeUndefined();
    expect(
      foundHost({
        name: "Sanctum",
        port: 4100,
        txt: { id },
        addresses: ["fe80::1"],
      }),
    ).toBeUndefined();
  });

  it("lists each host once", () => {
    const answer = {
      name: "Sanctum",
      port: 4100,
      txt: { id },
      addresses: ["192.168.1.20"],
    };
    const other = {
      ...answer,
      name: "Cabin",
      txt: { id: `${id.slice(0, -1)}0` },
    };

    expect(
      hostList([answer, { ...answer, addresses: ["192.168.1.22"] }, other]).map(
        (host) => [host.name, host.url],
      ),
    ).toEqual([
      ["Cabin", "https://192.168.1.20:4100"],
      ["Sanctum", "https://192.168.1.22:4100"],
    ]);
  });
});

describe("a development host", () => {
  it("is listed by what its status says", async () => {
    const hosts: unknown[] = [];
    const fetchStatus = vi.fn(async (_url: string | URL | Request) =>
      Response.json({ hostId: id, homeId, claimed: true }),
    );

    const stop = watchDevHost(
      "https://192.168.7.222:4100/anything",
      (host) => hosts.push(host),
      fetchStatus,
    );

    await vi.waitFor(() =>
      expect(hosts).toEqual([
        {
          id,
          homeId,
          name: "192.168.7.222",
          claimed: true,
          url: "https://192.168.7.222:4100",
        },
      ]),
    );
    expect(String(fetchStatus.mock.calls[0]![0])).toBe(
      "https://192.168.7.222:4100/api/auth/status",
    );
    stop();
  });

  it("is not listed while it does not answer as a host", async () => {
    const hosts: unknown[] = [];

    const stop = watchDevHost(
      "https://192.168.7.222:4100",
      (host) => hosts.push(host),
      async () => Response.json({ hello: "world" }),
    );

    await vi.waitFor(() => expect(hosts).toEqual([undefined]));
    stop();
  });
});
