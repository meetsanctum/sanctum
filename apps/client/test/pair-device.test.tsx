// @vitest-environment jsdom
import {
  pairingBinding,
  pairingConfirmation,
  pairingOpaque,
  pairingProtocol,
  pairingQrText,
  type HostView,
} from "@meetsanctum/auth-protocol";
import * as opaque from "@serenity-kit/opaque";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { PairDevice } from "../src/auth/PairDevice";
import { CoreError, coreJson, type CoreFetchInit } from "../src/core-fetch";
import { getShell, type FoundHost, type StoredHost } from "../src/shell";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

vi.mock("@meetsanctum/auth-protocol", async (importOriginal) => {
  const protocol =
    await importOriginal<typeof import("@meetsanctum/auth-protocol")>();
  return {
    ...protocol,
    pairingBinding: (...args: Parameters<typeof protocol.pairingBinding>) =>
      trackCrypto(protocol.pairingBinding(...args)),
    verifyPairingConfirmation: (
      ...args: Parameters<typeof protocol.verifyPairingConfirmation>
    ) => trackCrypto(protocol.verifyPairingConfirmation(...args)),
  };
});

const host: FoundHost = {
  id: "6b0f6f4e-2a52-4f8e-9a51-1d1d1f6e6e73",
  homeId: "0d5c1f0a-7a43-4b6e-8f0e-2f6a0c9b1e55",
  name: "Maya's home",
  claimed: true,
  url: "http://192.168.7.222:4100",
};
const pin = "hg6mmQxxksnFQb7m8qDqK0hT9z6lRb6vS8aW2b0FbUQ";

let root: Root;
let container: HTMLDivElement;
let polls: (() => unknown)[];
let requests: CoreFetchInit[];
// What the device sent to the fake host's exchange routes.
let answers: unknown[];
let bindings: Record<string, unknown>[];
let cryptoWork: Promise<unknown>[];
// The fake host's side of the exchange under way.
let exchange:
  | {
      requestId: string;
      exchangeId: string;
      password: string;
      clientLoginState: string;
      sessionKey?: string;
      finishLoginRequest?: string;
    }
  | undefined;
let exchangeCount: number;

beforeAll(() => opaque.ready);

function trackCrypto<T>(work: Promise<T>) {
  cryptoWork.push(work);
  return work;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  polls = [];
  requests = [];
  answers = [];
  bindings = [];
  cryptoWork = [];
  exchange = undefined;
  exchangeCount = 0;
  let lookups = ["K7", "W3", "P4", "M9"];
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
    const json = init.json as Record<string, string>;
    switch (path) {
      case "/api/auth/status":
        return { hostId: host.id, homeId: host.homeId, claimed: true };
      case "/api/auth/pair/request": {
        requests.push(init);
        const [lookup, ...rest] = lookups;
        lookups = rest;
        return {
          requestId: `request-${lookup}`,
          lookup,
          deviceSecret: `secret-${lookup}`,
          expiresAt: "2026-10-28T12:10:00Z",
        };
      }
      case "/api/auth/pair/poll": {
        const next = polls.shift();
        return next ? next() : { status: "waiting" };
      }
      case "/api/auth/pair/answer": {
        answers.push(json);
        if (exchange!.finishLoginRequest) {
          return {
            status: "continue",
            finishLoginRequest: exchange!.finishLoginRequest,
          };
        }
        const finished = opaque.client.finishLogin({
          clientLoginState: exchange!.clientLoginState,
          loginResponse: json.loginResponse!,
          password: exchange!.password,
          identifiers: pairingOpaque.identifiers,
          keyStretching: pairingOpaque.keyStretching,
        });
        if (!finished) return { status: "failed" };
        exchange!.sessionKey = finished.sessionKey;
        exchange!.finishLoginRequest = finished.finishLoginRequest;
        return {
          status: "continue",
          finishLoginRequest: finished.finishLoginRequest,
        };
      }
      case "/api/auth/pair/bind":
        bindings.push(json);
        return undefined;
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

async function render(
  onPaired = vi.fn<(host: StoredHost) => void>(),
  at: FoundHost = host,
) {
  await act(async () => {
    root.render(<PairDevice host={at} onBack={() => {}} onPaired={onPaired} />);
  });
  await settle();
  return onPaired;
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    // The fake clock moves the polls. Await the actual cryptographic work
    // so each assertion sees the binding or token check it depends on.
    while (cryptoWork.length > 0) {
      await Promise.all(cryptoWork.splice(0));
      await vi.advanceTimersByTimeAsync(0);
    }
  });
}

// The code the device shows, as people read it.
function shownCode() {
  return container.textContent!.match(
    /([2-9A-HJKMNP-TV-Z]{4})-([2-9A-HJKMNP-TV-Z]{4})/,
  );
}

// Someone types `typed` (or the shown code) on another device: the fake host
// starts an exchange, which the device's next poll answers.
async function typeCode(typed?: string) {
  const [, first, second] = shownCode()!;
  const code = typed ?? `${first}${second}`;
  exchangeCount += 1;
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
    password: code.slice(2),
  });
  exchange = {
    requestId: `request-${code.slice(0, 2)}`,
    exchangeId: `exchange-${exchangeCount}`,
    password: code.slice(2),
    clientLoginState,
  };
  const { exchangeId } = exchange;
  polls.push(() => ({ status: "exchange", exchangeId, startLoginRequest }));
  await settle(2_000);
}

function ids() {
  return { requestId: exchange!.requestId, exchangeId: exchange!.exchangeId };
}

// The fake host hands over the token, confirmed under the exchange's key
// unless a test says otherwise.
async function approve(
  view: HostView = { hostId: host.id, homeId: host.homeId!, pin: null },
  sessionKey = exchange?.sessionKey,
) {
  const confirmation = sessionKey
    ? await pairingConfirmation(sessionKey, view, ids(), "client_token")
    : "bm8tY29uZmlybWF0aW9u";
  polls.push(() => ({
    status: "paired",
    token: "client_token",
    client: { id: "tablet", kind: "shared" },
    confirmation,
  }));
}

describe("a shared device's pairing screen", () => {
  it("shows its code and QR code, asking the chosen host without a token", async () => {
    let finishRequest!: () => void;
    const ready = new Promise<void>((resolve) => {
      finishRequest = resolve;
    });
    const original = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation(async (path, init) => {
      if (path === "/api/auth/pair/request") await ready;
      return original(path, init);
    });
    await render();

    const liveRegion = container.querySelector(
      '[aria-live="polite"][aria-atomic="true"]',
    )!;
    expect(liveRegion.textContent).toBe("");
    finishRequest();
    await settle();

    const [formatted, first, second] = shownCode()!;
    expect(first).toMatch(/^K7/);
    expect(liveRegion.textContent).toBe(formatted);
    // The boxes Add a shared device types into, drawn with no input under
    // them, and hidden from screen readers, which hear the code in words.
    const boxes = container.querySelector('[data-slot="pairing-code"]')!;
    expect(boxes.getAttribute("aria-hidden")).toBe("true");
    expect(boxes.querySelector("input")).toBeNull();
    expect(
      [...boxes.children].map((part) => [
        part.getAttribute("data-slot"),
        [...part.querySelectorAll('[data-slot="input-otp-slot"]')].map(
          (slot) => slot.textContent,
        ),
      ]),
    ).toEqual([
      ["input-otp-group", [...first!]],
      ["input-otp-separator", []],
      ["input-otp-group", [...second!]],
    ]);
    expect(
      container.querySelector("svg[aria-label='Pairing QR code']"),
    ).not.toBeNull();
    expect(container.textContent).toContain("Waiting for approval");
    expect(container.textContent).toContain(
      "On a device that’s already connected to Maya's home, open Settings → Linked Devices.",
    );
    expect(requests).toEqual([
      expect.objectContaining({
        at: host.url,
        omitToken: true,
        json: {
          platform: "web",
          suggestedName: "Web browser",
          protocol: pairingProtocol,
        },
      }),
    ]);
  });

  it("asks for an app update and stops retrying when pairing is incompatible", async () => {
    const original = vi.mocked(coreJson).getMockImplementation()!;
    const request = vi
      .fn()
      .mockRejectedValue(new CoreError(409, "pairing_outdated"));
    vi.mocked(coreJson).mockImplementation((path, init) =>
      path === "/api/auth/pair/request" ? request() : original(path, init),
    );

    await render();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Update this app to pair it with this home.",
    );
    expect(shownCode()).toBeNull();

    await settle(15_000);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("answers the exchange for its code, binds it to the host it sees, and saves the confirmed token", async () => {
    const onPaired = await render();
    await typeCode();

    expect(answers).toEqual([
      expect.objectContaining({
        deviceSecret: "secret-K7",
        exchangeId: "exchange-1",
      }),
    ]);
    const view = { hostId: host.id, homeId: host.homeId!, pin: null };
    expect(bindings).toEqual([
      {
        deviceSecret: "secret-K7",
        exchangeId: "exchange-1",
        ...view,
        binding: await pairingBinding(exchange!.sessionKey!, view, ids()),
      },
    ]);

    await approve();
    await settle(2_000);

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

  it.each(["answer", "bind"])(
    "resends the same %s after losing the reply and saves the confirmed token",
    async (step) => {
      const original = vi.mocked(coreJson).getMockImplementation()!;
      const sent: unknown[] = [];
      vi.mocked(coreJson).mockImplementation(async (path, init) => {
        const result = await original(path, init);
        if (path === `/api/auth/pair/${step}`) {
          sent.push(init!.json);
          if (sent.length === 1) throw new TypeError("Lost reply");
        }
        return result;
      });
      const onPaired = await render();
      await typeCode();
      expect(container.textContent).toContain("Can't reach Sanctum");

      if (step === "bind") await approve();
      await settle(4_000);
      if (step === "answer") await approve();
      await settle(2_000);

      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(sent[0]);
      expect(requests).toHaveLength(1);
      expect(onPaired).toHaveBeenCalledWith(
        expect.objectContaining({ token: "client_token" }),
      );
    },
  );

  it("never sends the last six characters of its code", async () => {
    await render();
    await typeCode();
    const [, first, second] = shownCode()!;
    const secret = `${first}${second}`.slice(2);

    const sent = JSON.stringify(
      vi.mocked(coreJson).mock.calls.map(([, init]) => init?.json),
    );
    expect(sent).not.toContain(secret);
  });

  it("refuses a token no exchange checked, and shows a new code", async () => {
    const onPaired = await render();
    await approve(undefined, undefined);

    await settle(2_000);

    expect(onPaired).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "This home could not prove it is yours",
    );
    await settle(4_000);
    expect(requests).toHaveLength(2);
    expect(shownCode()![1]).toMatch(/^W3/);
  });

  it("refuses a token the checked host doesn't confirm", async () => {
    const onPaired = await render();
    await typeCode();
    await approve({ hostId: host.id, homeId: host.homeId!, pin });

    await settle(2_000);

    expect(onPaired).not.toHaveBeenCalled();
    expect(localStorage.getItem("sanctum.host")).toBeNull();
    expect(container.textContent).toContain(
      "This home could not prove it is yours",
    );
  });

  it("binds the pin of the certificate it sees, and keeps the pin out of its QR code", async () => {
    const checked: (string | null)[] = [];
    vi.spyOn(getShell(), "trust", "get").mockReturnValue({
      check: async (hostId) => void checked.push(hostId),
      candidate: async () => pin,
      failure: async () => null,
      resumed: async () => null,
    });
    const qr = await import("../src/qr-code");
    const text = vi.spyOn(qr, "QrCode");
    const onPaired = await render(vi.fn(), {
      ...host,
      url: "https://192.168.7.222:4100",
    });

    expect(checked).toEqual([host.id]);
    const [, first, second] = shownCode()!;
    expect(text.mock.calls.at(-1)?.[0].text).toBe(
      pairingQrText({
        hostId: host.id,
        homeId: host.homeId!,
        code: `${first}${second}`,
      }),
    );
    expect(container.textContent).not.toContain("certificate");

    await typeCode();
    expect(bindings[0]).toMatchObject({ pin });
    await approve({ hostId: host.id, homeId: host.homeId!, pin });
    await settle(2_000);
    expect(onPaired).toHaveBeenCalledWith(expect.objectContaining({ pin }));
  });

  it("saves nothing once the certificate it sees changed since its exchange", async () => {
    let seen = pin;
    vi.spyOn(getShell(), "trust", "get").mockReturnValue({
      check: async () => undefined,
      candidate: async () => seen,
      failure: async () => null,
      resumed: async () => null,
    });
    const onPaired = await render(vi.fn(), {
      ...host,
      url: "https://192.168.7.222:4100",
    });
    await typeCode();
    seen = "c29tZW9uZS1lbHNlcy1jZXJ0aWZpY2F0ZS1waW4tYnl0ZXM";
    await approve({ hostId: host.id, homeId: host.homeId!, pin });

    await settle(2_000);

    expect(onPaired).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "This home could not prove it is yours",
    );
  });

  it("shows a new code after three that didn't match, following a pause", async () => {
    await render();
    for (let i = 0; i < 3; i += 1) {
      await typeCode("K7AAAAAA");
      await settle(5_000);
    }

    expect(answers).toHaveLength(3);
    expect(bindings).toEqual([]);
    expect(shownCode()).toBeNull();
    await settle(30_000);
    expect(requests).toHaveLength(2);
    expect(shownCode()![1]).toMatch(/^W3/);
  });

  it("answers at most one exchange every 5 seconds", async () => {
    await render();
    await typeCode("K7AAAAAA");
    await typeCode("K7AAAAAB");

    expect(answers).toHaveLength(1);
  });

  it("rotates an exhausted code when the last exchange expires during a retry", async () => {
    await render();
    for (let i = 0; i < 2; i += 1) {
      await typeCode("K7AAAAAA");
      await settle(5_000);
    }
    const original = vi.mocked(coreJson).getMockImplementation()!;
    const lastAnswer: unknown[] = [];
    vi.mocked(coreJson).mockImplementation(async (path, init) => {
      if (path !== "/api/auth/pair/answer") return original(path, init);
      lastAnswer.push(init!.json);
      if (lastAnswer.length === 1) throw new TypeError("Lost reply");
      throw new CoreError(409, "expired");
    });

    await typeCode("K7AAAAAA");
    await settle(4_000);
    expect(lastAnswer).toHaveLength(2);
    expect(lastAnswer[1]).toEqual(lastAnswer[0]);
    expect(shownCode()).toBeNull();

    await settle(30_000);
    expect(shownCode()![1]).toMatch(/^W3/);
  });

  it("stops answering after six codes didn't match, until someone asks for a new code", async () => {
    await render();
    for (let i = 0; i < 6; i += 1) {
      const [, first] = shownCode()!;
      await typeCode(`${first!.slice(0, 2)}AAAAAA`);
      await settle(5_000);
      if (i === 2) await settle(30_000);
    }
    expect(answers).toHaveLength(6);

    expect(shownCode()).toBeNull();
    expect(requests).toHaveLength(2);
    expect(container.textContent).toContain(
      "This device stopped showing a codeA wrong code was entered too many times. Show a new code to add it.",
    );

    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Show a new code",
    )!;
    await act(async () => button.click());
    await settle();
    expect(shownCode()).not.toBeNull();
    await typeCode();
    expect(answers).toHaveLength(7);
  });

  it("shows a new code once its request expired", async () => {
    await render();
    const liveRegion = container.querySelector(
      '[aria-live="polite"][aria-atomic="true"]',
    )!;
    polls.push(() => {
      throw new CoreError(409, "expired");
    });

    await settle(2_000);

    expect(shownCode()![1]).toMatch(/^W3/);
    expect(liveRegion.textContent).toBe(shownCode()![0]);
  });

  it("retries saving a collected token without collecting it again", async () => {
    const save = vi.spyOn(getShell().credentials, "save");
    save.mockRejectedValueOnce(new Error("Storage temporarily unavailable"));
    const onPaired = await render();
    await typeCode();
    await approve();
    polls.push(() => {
      throw new CoreError(409, "expired");
    });

    await settle(2_000);
    expect(onPaired).not.toHaveBeenCalled();
    await settle(4_000);

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

    await settle(4_000);
    expect(requests).toHaveLength(1);
    expect(shownCode()).not.toBeNull();
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
    await settle(2_000);
    expect(shownCode()).toBeNull();
    expect(
      [
        ...container.querySelectorAll(
          '[data-slot="pairing-code"] [data-slot="input-otp-slot"]',
        ),
      ].map((slot) => slot.textContent),
    ).toEqual(Array.from({ length: 8 }, () => ""));
    expect(
      container.querySelector("svg[aria-label='Pairing QR code']"),
    ).toBeNull();
    expect(container.textContent).toContain("Can't reach Sanctum");
  });

  it("stops storage retries after leaving the pairing screen", async () => {
    const save = vi
      .spyOn(getShell().credentials, "save")
      .mockRejectedValue(new Error("Storage unavailable"));
    const onPaired = await render();
    await typeCode();
    await approve();
    await settle(2_000);
    await act(async () => root.render(null));
    await settle(30_000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(onPaired).not.toHaveBeenCalled();
  });

  it("says when it cannot reach the host, and keeps trying", async () => {
    await render();
    polls.push(() => {
      throw new TypeError("Failed to fetch");
    });

    await settle(2_000);
    expect(container.textContent).toContain("Can't reach Sanctum");

    await settle(4_000);
    expect(container.textContent).toContain("Waiting for approval");
    expect(shownCode()![1]).toMatch(/^K7/);
  });
});
