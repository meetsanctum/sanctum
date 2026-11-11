import type { HostStatus, SignedIn } from "@meetsanctum/auth-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hostStatus } from "../src/auth/device";
import {
  followHost,
  forgetHost,
  moveHost,
  rememberSignIn,
  replaceClient,
  selectHost,
} from "../src/auth/session";
import { currentCredential, setCredential } from "../src/core-fetch";
import { coreBaseUrl, setCoreBaseUrl } from "../src/core-url";
import { getShell, type FoundHost, type StoredHost } from "../src/shell";

vi.mock("../src/auth/device", () => ({ hostStatus: vi.fn() }));
vi.mock("../src/shell", () => ({ getShell: vi.fn() }));

const host: StoredHost = {
  hostId: "host-id",
  homeId: "home-id",
  name: "Home",
  url: "http://192.168.1.20:4100",
  clientId: "c1",
  token: "client_old",
  kind: "personal",
  pin: null,
};
const otherUrl = "http://192.168.1.21:4100";
const found: FoundHost = {
  id: host.hostId,
  homeId: host.homeId,
  name: host.name,
  claimed: true,
  url: host.url,
};
const save = vi.fn(async (_host: StoredHost) => {});
const forget = vi.fn(async (_token: string) => {});
let publish: (hosts: FoundHost[]) => void;
const stops: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(getShell).mockReturnValue({
    platform: "macos",
    deviceName: async () => "Mac",
    credentials: {
      isSecure: async () => true,
      load: async () => host,
      save,
      forget,
    },
    trust: null,
    discovery: {
      watch: (listener) => {
        publish = listener;
        return vi.fn();
      },
    },
    preferences: { get: async () => null, set: async () => {} },
  });
  selectHost(host);
});

afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
  vi.resetAllMocks();
  setCredential(null);
  setCoreBaseUrl(null);
});

describe("following a host", () => {
  it("keeps the stored address when discovery replies before its first check", async () => {
    let answer!: (status: HostStatus) => void;
    vi.mocked(hostStatus).mockImplementation((url) =>
      url === host.url
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : Promise.resolve({
            hostId: host.hostId,
            homeId: host.homeId,
            claimed: true,
          }),
    );
    const onFound = vi.fn();
    stops.push(followHost(host, onFound));
    publish([{ ...found, url: otherUrl }]);
    answer({ hostId: host.hostId, homeId: host.homeId, claimed: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(onFound.mock.calls).toEqual([[host.url]]);
  });

  it("retries known candidates when the current address stops answering", async () => {
    let isOnline = true;
    vi.mocked(hostStatus).mockImplementation(async (url) => {
      if (url === host.url && !isOnline) throw new Error("offline");
      return { hostId: host.hostId, homeId: host.homeId, claimed: true };
    });
    const onFound = vi.fn();
    stops.push(followHost(host, onFound));
    await vi.advanceTimersByTimeAsync(0);
    publish([{ ...found, url: otherUrl }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(onFound.mock.calls).toEqual([[host.url]]);

    isOnline = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFound.mock.calls).toEqual([[host.url], [otherUrl]]);
  });

  it("reports a certificate failure once no address answers as the host", async () => {
    let restored = true;
    vi.mocked(hostStatus).mockImplementation(async (url) => {
      if (url === host.url && restored) throw new TypeError("Failed to fetch");
      if (url === host.url)
        return { hostId: host.hostId, homeId: host.homeId, claimed: true };
      throw new TypeError("Failed to fetch");
    });
    const failure = vi.fn(
      async (url: string): Promise<"changed" | "invalid" | null> =>
        url === host.url ? "changed" : null,
    );
    vi.mocked(getShell).mockReturnValue({
      ...getShell(),
      trust: {
        check: vi.fn(),
        candidate: vi.fn(),
        failure,
        resumed: vi.fn(),
      },
    });
    const onFound = vi.fn();
    const onChanged = vi.fn();
    stops.push(followHost(host, onFound, onChanged));
    await vi.advanceTimersByTimeAsync(0);

    expect(onFound).not.toHaveBeenCalled();
    expect(onChanged.mock.calls).toEqual([[host.url, "changed", undefined]]);

    // Its own certificate at the wrong time, as when a clock is wrong.
    failure.mockResolvedValue("invalid");
    onChanged.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onChanged.mock.calls).toEqual([[host.url, "invalid", undefined]]);

    // A host that is only offline, or answers at another address, is not one.
    failure.mockResolvedValue(null);
    onChanged.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onChanged).not.toHaveBeenCalled();
    restored = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFound.mock.calls).toEqual([[host.url]]);
  });

  it("tries an address again when taking it failed", async () => {
    vi.mocked(hostStatus).mockImplementation(async (url) => {
      if (url === host.url) throw new Error("offline");
      return { hostId: host.hostId, homeId: host.homeId, claimed: true };
    });
    const onFound = vi
      .fn<(url: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("The move was refused"))
      .mockResolvedValue(undefined);
    stops.push(followHost(host, onFound));
    await vi.advanceTimersByTimeAsync(0);
    publish([{ ...found, url: otherUrl }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(onFound.mock.calls).toEqual([[otherUrl]]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFound.mock.calls).toEqual([[otherUrl], [otherUrl]]);
    // Taken this time, so it is not offered again.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFound.mock.calls).toEqual([[otherUrl], [otherUrl]]);
  });

  it("reports recovery at the same address after a certificate failure", async () => {
    vi.mocked(hostStatus).mockResolvedValue({
      hostId: host.hostId,
      homeId: host.homeId,
      claimed: true,
    });
    vi.mocked(getShell).mockReturnValue({
      ...getShell(),
      trust: {
        check: vi.fn(),
        candidate: vi.fn(),
        resumed: vi.fn(),
        failure: vi.fn(async () => "invalid" as const),
      },
    });
    const onFound = vi.fn();
    const onCertificate = vi.fn();
    stops.push(followHost(host, onFound, onCertificate));
    await vi.advanceTimersByTimeAsync(0);
    expect(onFound).toHaveBeenCalledTimes(1);

    vi.mocked(hostStatus).mockRejectedValue(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onCertificate).toHaveBeenCalledWith(host.url, "invalid", undefined);

    vi.mocked(hostStatus).mockResolvedValue({
      hostId: host.hostId,
      homeId: host.homeId,
      claimed: true,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFound.mock.calls).toEqual([[host.url], [host.url]]);

    // An unchanged healthy address does not trigger repeated notifications.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFound).toHaveBeenCalledTimes(2);
  });

  it("ignores answers received after following stops", async () => {
    let answer!: (status: HostStatus) => void;
    vi.mocked(hostStatus).mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const onFound = vi.fn();
    const stop = followHost(host, onFound);
    stop();
    answer({ hostId: host.hostId, homeId: host.homeId, claimed: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(onFound).not.toHaveBeenCalled();
  });

  it("ignores a certificate failure received after following stops", async () => {
    vi.mocked(hostStatus).mockRejectedValue(new TypeError("Failed to fetch"));
    let finish!: (failure: "changed") => void;
    const failure = vi.fn(
      () =>
        new Promise<"changed">((resolve) => {
          finish = resolve;
        }),
    );
    vi.mocked(getShell).mockReturnValue({
      ...getShell(),
      trust: { check: vi.fn(), candidate: vi.fn(), resumed: vi.fn(), failure },
    });
    const onChanged = vi.fn();
    const stop = followHost(host, vi.fn(), onChanged);
    await vi.advanceTimersByTimeAsync(0);
    expect(failure).toHaveBeenCalled();
    stop();
    finish("changed");
    await vi.advanceTimersByTimeAsync(0);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("following a home", () => {
  it("finds it on another host, whose certificate changed", async () => {
    vi.mocked(hostStatus).mockRejectedValue(new TypeError("Failed to fetch"));
    vi.mocked(getShell).mockReturnValue({
      ...getShell(),
      trust: {
        check: vi.fn(),
        candidate: vi.fn(),
        resumed: vi.fn(),
        failure: vi.fn(async (url: string) =>
          url === otherUrl ? ("changed" as const) : null,
        ),
      },
    });
    const onChanged = vi.fn();
    stops.push(followHost(host, vi.fn(), onChanged));
    await vi.advanceTimersByTimeAsync(0);
    const restored = { ...found, id: "new-host-id", url: otherUrl };
    // Another home on the network is not followed.
    publish([
      restored,
      { ...found, id: "x", homeId: "another-home", url: "http://x:4100" },
    ]);
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.mocked(hostStatus).mock.calls.map(([url]) => url)).not.toContain(
      "http://x:4100",
    );
    expect(onChanged.mock.calls).toEqual([[otherUrl, "changed", restored]]);
  });
});

describe("moving a host", () => {
  it("saves the address before moving authenticated requests there", async () => {
    let finish!: () => void;
    save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const moving = moveHost(host, otherUrl);
    expect(coreBaseUrl()).toBe(host.url);
    finish();
    expect(await moving).toEqual({ ...host, url: otherUrl });
    expect(currentCredential()).toEqual({
      url: otherUrl,
      token: host.token,
      pin: null,
    });
  });

  it("does not restore a token invalidated while its address was being saved", async () => {
    let finish!: () => void;
    save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const moving = moveHost(host, otherUrl);
    setCredential(null);
    finish();
    expect(await moving).toBeNull();
    expect(currentCredential()).toBeNull();
  });

  it("ignores address changes for an older sign-in", async () => {
    selectHost({ ...host, token: "client_new" });
    expect(await moveHost(host, otherUrl)).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(currentCredential()?.token).toBe("client_new");
  });
});

describe("forgetting a host", () => {
  it("blocks address changes while forgetting the saved home", async () => {
    let finish!: () => void;
    forget.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const forgetting = forgetHost(host);
    expect(await moveHost(host, otherUrl)).toBeNull();
    expect(save).not.toHaveBeenCalled();
    finish();
    await forgetting;
    expect(currentCredential()).toBeNull();
  });

  it("does not replace a newer sign-in when forgetting fails", async () => {
    let fail!: (error: Error) => void;
    forget.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const forgetting = forgetHost(host);
    selectHost({ ...host, url: otherUrl, token: "client_new" });
    fail(new Error("Storage unavailable"));
    await expect(forgetting).rejects.toThrow("Storage unavailable");
    expect(currentCredential()).toEqual({
      url: otherUrl,
      token: "client_new",
      pin: null,
    });
  });

  it("does not restore an older home when its storage removal fails", async () => {
    setCredential(null);
    forget.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(forgetHost(host)).rejects.toThrow("Storage unavailable");
    expect(currentCredential()).toBeNull();
  });
});

describe("remembering a sign-in", () => {
  const signedIn = {
    token: "client_signed_in",
    client: { id: "c2" },
  } as SignedIn;
  const checked = { pin: null, homeId: host.homeId };

  it("does not save a cancelled exchange", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      rememberSignIn(found, signedIn, checked, controller.signal),
    ).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
    expect(currentCredential()?.token).toBe(host.token);
  });

  it("removes a cancelled save without selecting its token", async () => {
    const controller = new AbortController();
    let finish!: () => void;
    save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const saving = rememberSignIn(found, signedIn, checked, controller.signal);
    controller.abort();
    finish();
    await expect(saving).rejects.toThrow();
    expect(forget).toHaveBeenCalledWith(signedIn.token);
    expect(currentCredential()?.token).toBe(host.token);
  });
});

describe("replacing the client after a changed certificate", () => {
  it("revokes the old personal client with the new token, once", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const current = { ...host, clientId: "c2", token: "client_new" };
    selectHost(current);

    await replaceClient(host, current);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [target, init] = fetch.mock.calls[0]!;
    expect(String(target)).toBe(`${host.url}/api/auth/clients/revoke`);
    expect(JSON.parse(String(init?.body))).toEqual({ id: "c1" });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer client_new",
    );

    // Not for a shared client, another home, or the same client.
    fetch.mockClear();
    await replaceClient({ ...host, kind: "shared" }, current);
    await replaceClient({ ...host, homeId: "another-home" }, current);
    await replaceClient(current, current);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("revokes it on another host serving the same home, as after a restore", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const current = {
      ...host,
      hostId: "new-host-id",
      clientId: "c2",
      token: "client_new",
    };
    selectHost(current);

    await replaceClient(host, current);

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
