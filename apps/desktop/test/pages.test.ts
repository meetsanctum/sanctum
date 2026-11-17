import { BrowserWindow, session, type Session } from "electron";
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPages } from "../src/pages.js";
import { accept, refuse, type HostTrust } from "../src/trust.js";
import { testCa } from "./certificates.js";

afterEach(() => vi.restoreAllMocks());

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    BrowserWindow: vi.fn(function () {
      return Object.assign(new EventEmitter(), {
        webContents: Object.assign(new EventEmitter(), {
          send: vi.fn(),
          setWebRTCIPHandlingPolicy: vi.fn(),
        }),
        loadURL: vi.fn(),
        setWindowButtonVisibility: vi.fn(),
        setWindowButtonPosition: vi.fn(),
        show: vi.fn(),
        focus: vi.fn(),
        isFocused: () => false,
        getBounds: () => ({ x: 0, y: 0, width: 1100, height: 760 }),
        destroy: vi.fn(),
      });
    }),
    session: {
      fromPartition: vi.fn(() => ({
        protocol: { handle: vi.fn() },
        setCertificateVerifyProc: vi.fn(),
        webRequest: {
          onBeforeRequest: vi.fn(),
          onBeforeSendHeaders: vi.fn(),
        },
        closeAllConnections: vi.fn(async () => {}),
      })),
    },
  };
});

type Verdict = Awaited<ReturnType<HostTrust["verify"]>>;

function setUp(
  result: Promise<Verdict>,
  certificates: string[] = [],
  isAccepted = true,
) {
  vi.clearAllMocks();
  const trust: HostTrust = {
    start: async () => {},
    verify: (_hostname, _chain, onChecked) => {
      if (certificates.length) onChecked?.(certificates, isAccepted);
      return result;
    },
    isChecking: () => false,
    check: () => false,
    candidate: () => null,
    failure: () => null,
    save: async () => {},
    forget: async () => false,
  };
  const pages = createPages({
    clientRoot: "/client",
    preload: "/preload.cjs",
    allowPlainHttp: false,
    trust: () => trust,
    lockDown: () => {},
  });
  pages.open();
  const own = vi.mocked(session.fromPartition).mock.results[0]!
    .value as Session;
  const verify = vi.mocked(own.setCertificateVerifyProc).mock.calls[0]![0]!;
  const callback = vi.fn();
  verify(
    {
      hostname: "192.168.1.20",
      certificate: { data: "certificate" },
    } as Parameters<typeof verify>[0],
    callback,
  );
  return { pages, own, callback };
}

describe("the page's certificate session", () => {
  it("retries a cached date refusal once a corrected clock makes it valid", async () => {
    const ca = await testCa();
    const leaf = await ca.leaf();
    const start = Date.parse(new X509Certificate(leaf).validFrom);
    const clock = vi.spyOn(Date, "now").mockReturnValue(start - 1);
    const { own } = setUp(Promise.resolve(refuse), [leaf, ca.pem], false);
    await Promise.resolve();
    const beforeRequest = vi.mocked(own.webRequest.onBeforeRequest).mock
      .calls[0]![0]!;
    const details = {
      url: "https://192.168.1.20/api/health",
      frame: { parent: null, url: "app://sanctum/" },
    } as Parameters<typeof beforeRequest>[0];
    const callback = vi.fn();

    // No reload loop while the dates still do not fit.
    beforeRequest(details, callback);
    expect(own.closeAllConnections).not.toHaveBeenCalled();
    clock.mockReturnValue(start);
    beforeRequest(details, callback);
    expect(callback).toHaveBeenLastCalledWith({ cancel: true });
    await Promise.resolve();
    expect(BrowserWindow).toHaveBeenCalledTimes(2);
  });

  it.each(["leaf expiry", "CA expiry", "clock moved back"])(
    "replaces cached acceptance at %s before another request or WebSocket",
    async (boundary) => {
      const ca = await testCa(
        boundary === "CA expiry" ? { notAfter: Date.now() + 60_000 } : {},
      );
      const leaf = await ca.leaf();
      const certificates = [leaf, ca.pem];
      const { pages, own } = setUp(Promise.resolve(accept), certificates);
      await Promise.resolve();
      const beforeRequest = vi.mocked(own.webRequest.onBeforeRequest).mock
        .calls[0]![0]!;
      const request = (url: string) => {
        const callback = vi.fn();
        beforeRequest(
          {
            url,
            frame: { parent: null, url: "app://sanctum/" },
          } as Parameters<typeof beforeRequest>[0],
          callback,
        );
        return callback;
      };
      expect(request("https://192.168.1.20/api/health")).toHaveBeenCalledWith({
        cancel: false,
      });

      const certificate = new X509Certificate(
        boundary === "CA expiry" ? ca.pem : leaf,
      );
      vi.spyOn(Date, "now").mockReturnValue(
        boundary === "clock moved back"
          ? Date.parse(certificate.validFrom) - 1
          : Date.parse(certificate.validTo),
      );
      expect(request("wss://192.168.1.20/api/live")).toHaveBeenCalledWith({
        cancel: true,
      });
      expect(own.closeAllConnections).toHaveBeenCalledTimes(1);
      const old = vi.mocked(BrowserWindow).mock.results[0]!
        .value as BrowserWindow;
      expect(pages.isCurrent(old.webContents)).toBe(false);
      // Retired pages cannot send another request, even if the clock recovers.
      vi.spyOn(Date, "now").mockRestore();
      expect(request("https://192.168.1.20/api/auth/me")).toHaveBeenCalledWith({
        cancel: true,
      });
      expect(request("app://sanctum/index.html")).toHaveBeenCalledWith({
        cancel: false,
      });
      await Promise.resolve();
      expect(BrowserWindow).toHaveBeenCalledTimes(2);
    },
  );

  it("revokes the old page's bridge before waiting for connections to close", async () => {
    const { pages, own } = setUp(Promise.resolve(accept));
    await Promise.resolve();
    const old = vi.mocked(BrowserWindow).mock.results[0]!
      .value as BrowserWindow;
    let finish!: () => void;
    vi.mocked(own.closeAllConnections).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    expect(pages.isCurrent(old.webContents)).toBe(true);
    const refreshing = pages.refresh(null);
    const isStillCurrent = pages.isCurrent(old.webContents);
    finish();
    await refreshing;
    expect(isStillCurrent).toBe(false);
  });

  it("replaces a session with an unfinished verification when trust changes", async () => {
    let finish!: (verdict: Verdict) => void;
    const verdict = new Promise<Verdict>((resolve) => {
      finish = resolve;
    });
    const { pages, own, callback } = setUp(verdict);
    const resume = { name: "sign-in" };
    await pages.refresh(resume);
    expect(BrowserWindow).toHaveBeenCalledTimes(2);
    expect(own.closeAllConnections).toHaveBeenCalled();
    expect(pages.resumed()).toEqual(resume);
    // The old check can still finish and cache a refusal in its own session.
    finish(refuse);
    await verdict;
    expect(callback).toHaveBeenCalledWith(refuse);
  });

  it.each([accept, refuse] as const)(
    "replaces a session that cached verdict %s",
    async (verdict) => {
      const { pages } = setUp(Promise.resolve(verdict));
      await Promise.resolve();
      await pages.refresh(null);
      expect(BrowserWindow).toHaveBeenCalledTimes(2);
    },
  );
});

describe("the window's sidebar", () => {
  it("sends View's Show sidebar or Hide sidebar to the page on show", () => {
    const { pages } = setUp(Promise.resolve(accept));
    pages.toggleSidebar();
    const window = vi.mocked(BrowserWindow).mock.results[0]!
      .value as BrowserWindow;
    expect(window.webContents.send).toHaveBeenCalledWith(
      "window:toggle-sidebar",
    );
  });

  it.runIf(process.platform === "darwin")(
    "shows and hides the traffic lights with it on macOS, in their place",
    () => {
      const { pages } = setUp(Promise.resolve(accept));
      const window = vi.mocked(BrowserWindow).mock.results[0]!
        .value as BrowserWindow;
      pages.setWindowControls(false, 0);
      pages.setWindowControls(true, 0);
      expect(vi.mocked(window.setWindowButtonVisibility).mock.calls).toEqual([
        [false],
        [true],
      ]);
      // macOS would put them back in its corner.
      const positions = vi.mocked(window.setWindowButtonPosition).mock;
      expect(positions.calls.at(-1)).toEqual([{ x: 20, y: 20 }]);
      expect(positions.invocationCallOrder.at(-1)).toBeGreaterThan(
        vi
          .mocked(window.setWindowButtonVisibility)
          .mock.invocationCallOrder.at(-1)!,
      );
    },
  );
});

describe("the frames apps' pages show in", () => {
  const code = "0123456789abcdef0123456789abcdef";
  const folder = `/pages/page_${"A".repeat(43)}/apps/sanctum.weather/0123456789abcdef/`;
  const entry = `https://192.168.1.20:4100${folder}#hello=${code}`;
  const frame = { parent: {}, url: entry };

  function shown() {
    const { pages, own } = setUp(Promise.resolve(accept));
    const window = vi.mocked(BrowserWindow).mock.results[0]!
      .value as BrowserWindow;
    const navigate = (url: string, isMainFrame = false) => {
      const event = { url, isMainFrame, preventDefault: vi.fn() };
      window.webContents.emit("will-frame-navigate", event);
      return !event.preventDefault.mock.calls.length;
    };
    const beforeRequest = vi.mocked(own.webRequest.onBeforeRequest).mock
      .calls[0]![0]!;
    const request = (details: object) => {
      const callback = vi.fn();
      beforeRequest(details as Parameters<typeof beforeRequest>[0], callback);
      return callback.mock.calls[0]![0] as { cancel: boolean };
    };
    return { pages, window, navigate, request };
  }

  it("get the preload, which takes WebRTC out of them, and no UDP but a proxy's", () => {
    const { window } = shown();
    const options = vi.mocked(BrowserWindow).mock.calls[0]![0]!;
    expect(options.webPreferences).toMatchObject({
      nodeIntegrationInSubFrames: true,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    });
    expect(window.webContents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith(
      "disable_non_proxied_udp",
    );
  });

  it("go only where the page named, and never by a redirect", () => {
    const { pages, window, navigate } = shown();
    expect(navigate(entry)).toBe(false);
    expect(pages.allowFrame(entry)).toBe(true);
    expect(navigate(entry)).toBe(true);
    expect(navigate(entry.replace("weather", "moods"))).toBe(false);
    // The client's own navigations are main.ts's to check.
    expect(navigate("app://sanctum/", true)).toBe(true);
    pages.endFrame(entry);
    expect(navigate(entry)).toBe(false);
    const redirect = { isMainFrame: false, preventDefault: vi.fn() };
    window.webContents.emit("will-redirect", redirect);
    expect(redirect.preventDefault).toHaveBeenCalled();
  });

  it("load only their own page and the kit", () => {
    const { pages, request } = shown();
    pages.allowFrame(entry);
    const at = (path: string) => `https://192.168.1.20:4100${path}`;
    expect(
      request({ url: at(`${folder}index.js`), resourceType: "script", frame })
        .cancel,
    ).toBe(false);
    expect(
      request({ url: at("/api/devices"), resourceType: "xhr", frame }).cancel,
    ).toBe(true);
    // The client's own requests are as before.
    expect(
      request({
        url: at("/api/devices"),
        resourceType: "xhr",
        frame: { parent: null, url: "app://sanctum/" },
      }).cancel,
    ).toBe(false);
    // A frame gone while it's asked about gets nothing.
    const gone = {
      get parent(): never {
        throw new Error("Render frame was disposed");
      },
    };
    expect(
      request({
        url: at(`${folder}index.js`),
        resourceType: "script",
        frame: gone,
      }).cancel,
    ).toBe(true);
  });

  it.each([null, undefined])(
    "refuses a request whose frame is unavailable (%s)",
    (frame) => {
      const { pages, request } = shown();
      pages.allowFrame(entry);
      expect(
        request({
          url: "https://192.168.1.20:4100/api/devices",
          resourceType: "xhr",
          frame,
          initiatorOrigin: "null",
        }).cancel,
      ).toBe(true);
    },
  );
});
