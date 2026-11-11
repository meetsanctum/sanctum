// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PairDevice } from "../src/auth/PairDevice";
import { CoreError, coreJson, type CoreFetchInit } from "../src/core-fetch";
import { getShell, type FoundHost, type StoredHost } from "../src/shell";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const host: FoundHost = {
  id: "6b0f6f4e-2a52-4f8e-9a51-1d1d1f6e6e73",
  homeId: "0d5c1f0a-7a43-4b6e-8f0e-2f6a0c9b1e55",
  name: "Maya's home",
  claimed: true,
  url: "http://192.168.3.222:4100",
};

let root: Root;
let container: HTMLDivElement;
let polls: (() => unknown)[];
let requests: CoreFetchInit[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  polls = [];
  requests = [];
  let codes = ["K7QXM4PD", "W3RT9HNC"];
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
    switch (path) {
      case "/api/auth/status":
        return { hostId: host.id, homeId: host.homeId, claimed: true };
      case "/api/auth/pair/request": {
        requests.push(init);
        const [code, ...rest] = codes;
        codes = rest;
        return {
          code,
          deviceSecret: `secret-${code}`,
          expiresAt: "2026-10-28T12:10:00Z",
        };
      }
      case "/api/auth/pair/poll": {
        const next = polls.shift();
        return next ? next() : { status: "waiting" };
      }
      default:
        throw new Error(`Unexpected request: ${path}`);
    }
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(onPaired = vi.fn<(host: StoredHost) => void>()) {
  await act(async () => {
    root.render(
      <PairDevice host={host} onBack={() => {}} onPaired={onPaired} />,
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return onPaired;
}

describe("a shared device's pairing screen", () => {
  it("shows its code and QR code, asking the chosen host without a token", async () => {
    await render();

    expect(container.textContent).toContain("K7QX-M4PD");
    expect(
      container.querySelector("svg[aria-label='Pairing QR code']"),
    ).not.toBeNull();
    expect(container.textContent).toContain("Waiting for someone");
    expect(requests).toEqual([
      expect.objectContaining({
        at: host.url,
        omitToken: true,
        json: { platform: "web", suggestedName: "Web browser" },
      }),
    ]);
  });

  it("stores its token and goes home once someone approved it", async () => {
    const onPaired = await render();
    polls.push(() => ({
      status: "paired",
      token: "client_token",
      client: { id: "tablet", kind: "shared" },
    }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    const stored = {
      hostId: host.id,
      homeId: host.homeId,
      name: host.name,
      url: host.url,
      clientId: "tablet",
      token: "client_token",
      kind: "shared",
      pin: null,
    };
    expect(onPaired).toHaveBeenCalledWith(stored);
    expect(JSON.parse(localStorage.getItem("sanctum.host")!)).toEqual(stored);
  });

  it("carries the pin of the certificate it sees, and shows the short pin", async () => {
    const pin = "hg6mmQxxksnFQb7m8qDqK0hT9z6lRb6vS8aW2b0FbUQ";
    const checked: (string | null)[] = [];
    vi.spyOn(getShell(), "trust", "get").mockReturnValue({
      check: async (hostId) => void checked.push(hostId),
      candidate: async () => pin,
      failure: async () => null,
      resumed: async () => null,
    });
    const { pairingQrText, shortPin } =
      await import("@meetsanctum/auth-protocol");
    const qr = await import("../src/qr-code");
    const text = vi.spyOn(qr, "QrCode");
    const onPaired = vi.fn<(host: StoredHost) => void>();
    await act(async () => {
      root.render(
        <PairDevice
          host={{ ...host, url: "https://192.168.3.222:4100" }}
          onBack={() => {}}
          onPaired={onPaired}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(checked).toEqual([host.id]);
    expect(container.textContent).toContain(
      `Home certificate ${shortPin(pin)}`,
    );
    expect(text.mock.calls.at(-1)?.[0].text).toBe(
      pairingQrText({
        hostId: host.id,
        homeId: host.homeId!,
        code: "K7QXM4PD",
        pin,
      }),
    );

    polls.push(() => ({
      status: "paired",
      token: "client_token",
      client: { id: "tablet", kind: "shared" },
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(onPaired).toHaveBeenCalledWith(expect.objectContaining({ pin }));
  });

  it("shows a new code once its request expired", async () => {
    await render();
    polls.push(() => {
      throw new CoreError(409, "expired");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(container.textContent).toContain("W3RT-9HNC");
    expect(container.textContent).not.toContain("K7QX-M4PD");
  });

  it("retries saving a collected token without collecting it again", async () => {
    const save = vi.spyOn(getShell().credentials, "save");
    save.mockRejectedValueOnce(new Error("Storage temporarily unavailable"));
    polls.push(() => ({
      status: "paired",
      token: "client_token",
      client: { id: "tablet", kind: "shared" },
    }));
    polls.push(() => {
      throw new CoreError(409, "expired");
    });
    const onPaired = await render();
    expect(onPaired).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    expect(save).toHaveBeenCalledTimes(2);
    expect(onPaired).toHaveBeenCalledWith(
      expect.objectContaining({ token: "client_token", clientId: "tablet" }),
    );
    expect(requests).toHaveLength(1);
    expect(polls).toHaveLength(1);
  });

  it("retries when the shell cannot read the device name", async () => {
    vi.spyOn(getShell(), "deviceName").mockRejectedValueOnce(
      new Error("IPC failed"),
    );
    await render();
    expect(container.textContent).toContain("Can't read this device's name");
    expect(requests).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(requests).toHaveLength(1);
    expect(container.textContent).toContain("K7QX-M4PD");
  });

  it("removes an expired code while its replacement cannot be fetched", async () => {
    await render();
    polls.push(() => {
      throw new CoreError(409, "expired");
    });
    const original = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation((path, init) => {
      if (path === "/api/auth/pair/request") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return original(path, init);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(container.textContent).not.toContain("K7QX-M4PD");
    expect(
      container.querySelector("svg[aria-label='Pairing QR code']"),
    ).toBeNull();
    expect(container.textContent).toContain("Can't reach Sanctum");
  });

  it("stops storage retries after leaving the pairing screen", async () => {
    const save = vi
      .spyOn(getShell().credentials, "save")
      .mockRejectedValue(new Error("Storage unavailable"));
    polls.push(() => ({
      status: "paired",
      token: "client_token",
      client: { id: "tablet" },
    }));
    const onPaired = await render();
    await act(async () => root.render(null));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(onPaired).not.toHaveBeenCalled();
  });

  it("says when it cannot reach the host, and keeps trying", async () => {
    await render();
    polls.push(() => {
      throw new TypeError("Failed to fetch");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(container.textContent).toContain("Can't reach Sanctum");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(container.textContent).toContain("Waiting for someone");
    expect(container.textContent).toContain("K7QX-M4PD");
  });
});
