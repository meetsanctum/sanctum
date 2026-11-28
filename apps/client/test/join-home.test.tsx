// @vitest-environment jsdom
import type { RedeemFinished } from "@meetsanctum/auth-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";
import { checkHost, signIn, SignInError } from "../src/auth/device";
import {
  checkInviteCode,
  finishJoin,
  JoinError,
  type CheckedCode,
} from "../src/auth/join";
import { suggestedUsername } from "../src/auth/JoinHome";
import { CoreError, setCredential } from "../src/core-fetch";
import { setCoreBaseUrl } from "../src/core-url";
import type { FoundHost, Shell } from "../src/shell";
import { deferred } from "./deferred";

// Joining with an invite code from the sign-in screens: Just me says so,
// Sign in links to it, the code is checked as it fills, and Welcome
// chooses a username and password, then signs this device in.

vi.mock("../src/auth/device", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth/device")>()),
  checkHost: vi.fn(),
  signIn: vi.fn(),
}));
vi.mock("../src/auth/join", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth/join")>()),
  checkInviteCode: vi.fn(),
  finishJoin: vi.fn(),
}));

const office: FoundHost = {
  id: "6b0f6f4e-2a52-4f8e-9a51-1d1d1f6e6e73",
  homeId: "0d5c1f0a-7a43-4b6e-8f0e-2f6a0c9b1e55",
  name: "Office",
  claimed: true,
  url: "https://192.168.7.222:4100",
};

const maya = {
  id: "maya",
  name: "Maya Keller",
  avatar: null,
  colour: "#b9defc",
};

const checked = (username: string | null = null): CheckedCode => ({
  checked: { redeemId: "choose", person: maya, username },
  sessionKey: "key",
  host: { hostId: office.id, homeId: office.homeId!, pin: null },
});

let root: Root;
let container: HTMLDivElement;
let publish: (hosts: FoundHost[]) => void;
let saved: unknown[];
let trust: {
  check: ReturnType<typeof vi.fn<ShellTrust["check"]>>;
  resumed: ReturnType<typeof vi.fn<ShellTrust["resumed"]>>;
} & ShellTrust;
let save: Shell["credentials"]["save"];
type ShellTrust = NonNullable<Shell["trust"]>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
  saved = [];
  save = async (host) => {
    saved.push(host);
  };
  trust = {
    check: vi.fn(async () => {}),
    resumed: vi.fn(async () => null),
    candidate: async () => null,
    failure: async () => null,
  };
  vi.stubGlobal("sanctumShell", {
    platform: "macos",
    deviceName: async () => "Maya's MacBook",
    discovery: {
      watch: (onHosts) => {
        publish = onHosts;
        onHosts([]);
        return () => {};
      },
    },
    credentials: {
      isSecure: async () => true,
      load: async () => null,
      save: (host) => save(host),
      forget: async () => {},
    },
    trust,
    preferences: { get: async () => null, set: async () => {} },
  } satisfies Shell);
  vi.mocked(checkHost).mockResolvedValue({
    homeId: office.homeId!,
    pin: null,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
  await act(async () => publish([office]));
  await click("Office");
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setCredential(null);
  setCoreBaseUrl(null);
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const title = () => container.querySelector("h1")?.textContent;

async function click(text: string) {
  const found = [...container.querySelectorAll("button")].find((each) =>
    each.textContent!.includes(text),
  );
  expect(found, text).toBeDefined();
  await act(async () => found!.click());
}

const setValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)!.set!;

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // The check runs after the last character lands.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function fill(label: string, value: string) {
  const input = [...container.querySelectorAll("label")].find(
    (each) => each.textContent === label,
  )?.control as HTMLInputElement;
  expect(input, label).toBeInstanceOf(HTMLInputElement);
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

const codeField = () =>
  container.querySelector<HTMLInputElement>('input[aria-label="Invite code"]')!;

async function openJoin() {
  await click("Just me");
  await click("I have an invite code");
}

describe("joining with an invite code", () => {
  it("is offered under Just me and Sign in", async () => {
    expect(container.textContent).toContain(
      "Sign in, or join with an invite code.",
    );
    await openJoin();
    expect(title()).toBe("Join Office");
    expect(container.textContent).toContain(
      "The code has 8 letters and digits, such as K7QX-M4PD.",
    );
    await click("Back");
    expect(title()).toBe("Sign in to Office");
  });

  it("keeps checking the chosen home's certificate when joining after a failed sign-in", async () => {
    vi.mocked(signIn).mockRejectedValue(
      new SignInError("wrong_username_or_password"),
    );
    await click("Just me");
    await fill("Username", "maya");
    await fill("Password", "incorrect");
    await click("Sign in");
    expect(signIn).toHaveBeenCalledOnce();
    await click("I have an invite code");
    expect(trust.check).toHaveBeenLastCalledWith(office.id, {
      name: "join",
      host: office,
    });
  });

  it("resumes Join after the desktop replaces its session", async () => {
    trust.resumed.mockResolvedValueOnce({ name: "join", host: office });
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<App />));
    expect(title()).toBe("Join Office");
  });

  it("checks the code once it's whole, then welcomes the person", async () => {
    vi.mocked(checkInviteCode).mockResolvedValue(checked());
    await openJoin();
    expect(document.activeElement).toBe(codeField());
    await type(codeField(), "k7qxm4pd");

    expect(checkInviteCode).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "K7QXM4PD",
        host: { hostId: office.id, homeId: office.homeId, pin: null },
      }),
    );
    expect(title()).toBe("Welcome, Maya Keller");
    expect(document.activeElement).toBe(
      container.querySelector('input[autocomplete="new-password"]'),
    );
    expect(
      (
        [...container.querySelectorAll("label")].find(
          (each) => each.textContent === "Username",
        )?.control as HTMLInputElement
      ).value,
    ).toBe("maya");
  });

  it("keeps a wrong code's characters, selected, and says what to do", async () => {
    vi.mocked(checkInviteCode).mockRejectedValue(new JoinError("wrong_code"));
    await openJoin();
    await type(codeField(), "K7QXM4PD");
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "This code doesn’t work. Check each character, or try again in a few minutes.",
    );
    expect(codeField().value).toBe("K7QXM4PD");
    expect(codeField().selectionStart).toBe(0);
    expect(codeField().selectionEnd).toBe(8);
    expect(codeField().getAttribute("aria-invalid")).toBe("true");
  });

  it("says when a right code has ended", async () => {
    vi.mocked(checkInviteCode).mockRejectedValue(
      new CoreError(410, "invite_ended"),
    );
    await openJoin();
    await type(codeField(), "K7QXM4PD");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "This code has ended. Ask someone at home for a new one.",
    );
  });

  it("joins with the chosen username and password, or says it's taken", async () => {
    vi.mocked(checkInviteCode).mockResolvedValue(checked());
    vi.mocked(finishJoin)
      .mockRejectedValueOnce(new CoreError(409, "username_taken"))
      .mockResolvedValueOnce({
        token: "client_token",
        confirmation: "mac",
        client: { id: "macbook", kind: "personal" },
        person: maya,
      } as RedeemFinished);
    await openJoin();
    await type(codeField(), "K7QXM4PD");
    const username = await fill("Username", "maya");
    const password = await fill("Password", "staple battery horse");
    const reveal = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show password"]',
    )!;
    expect(password.type).toBe("password");
    await act(async () => reveal.click());
    expect(password.type).toBe("text");
    expect(password.value).toBe("staple battery horse");
    await act(async () => reveal.click());
    expect(password.type).toBe("password");
    expect(password.value).toBe("staple battery horse");
    await click("Join");

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "That username is taken. Try another.",
    );
    expect(username.getAttribute("aria-invalid")).toBe("true");

    await fill("Username", "maya.k");
    await click("Join");
    expect(finishJoin).toHaveBeenLastCalledWith(
      expect.objectContaining({
        username: "maya.k",
        password: "staple battery horse",
        client: { name: "Maya's MacBook", platform: "macos" },
      }),
    );
    expect(saved).toEqual([
      expect.objectContaining({ token: "client_token", kind: "personal" }),
    ]);
    expect(container.querySelector(".home-screen")).not.toBeNull();
  });

  it("keeps Back disabled until the joined device's credentials are saved", async () => {
    const joining = deferred<RedeemFinished>();
    const saving = deferred<void>();
    save = vi.fn(() => saving.promise);
    vi.mocked(checkInviteCode).mockResolvedValue(checked());
    vi.mocked(finishJoin).mockReturnValue(joining.promise);
    await openJoin();
    await type(codeField(), "K7QXM4PD");
    await fill("Password", "staple battery horse");
    await click("Join");
    const back = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Back"]',
    )!;
    expect(back.disabled).toBe(true);
    await click("Back");
    expect(title()).toBe("Welcome, Maya Keller");

    await act(async () =>
      joining.resolve({
        token: "client_token",
        confirmation: "mac",
        client: { id: "macbook", kind: "personal" },
        person: maya,
      } as RedeemFinished),
    );
    expect(save).toHaveBeenCalledOnce();
    expect(back.disabled).toBe(true);
    for (const shortcut of [{ key: "Escape" }, { key: "[", metaKey: true }]) {
      await act(async () =>
        document.activeElement!.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            ...shortcut,
          }),
        ),
      );
      expect(title()).toBe("Welcome, Maya Keller");
    }
    await act(async () => saving.resolve());
    expect(container.querySelector(".home-screen")).not.toBeNull();
  });

  it("keeps a reset's username", async () => {
    vi.mocked(checkInviteCode).mockResolvedValue(checked("mayak"));
    await openJoin();
    await type(codeField(), "K7QXM4PD");
    const username = [...container.querySelectorAll("label")].find(
      (each) => each.textContent === "Username",
    )?.control as HTMLInputElement;
    expect(username.value).toBe("mayak");
  });

  it("asks for the code again when choosing took too long", async () => {
    vi.mocked(checkInviteCode).mockResolvedValue(checked());
    vi.mocked(finishJoin).mockRejectedValue(new CoreError(410, "expired"));
    await openJoin();
    await type(codeField(), "K7QXM4PD");
    await fill("Password", "staple battery horse");
    await click("Join");

    expect(title()).toBe("Join Office");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "That took too long. Enter the code again.",
    );
  });
});

describe("Forgot your password?", () => {
  const forgotField = () =>
    container.querySelector<HTMLInputElement>(
      'input[aria-label="Recovery code or password code"]',
    )!;

  it("asks for a recovery or password code, and says who can make one", async () => {
    await click("Just me");
    await click("Forgot your password?");

    expect(title()).toBe("Forgot your password?");
    expect(container.textContent).toContain(
      "Enter your recovery code, or a password code someone at home made for you.",
    );
    expect(container.textContent).toContain(
      "No code? Someone at home can make you one on your page in Settings → People.",
    );
    expect(document.activeElement).toBe(forgotField());
    await click("Back");
    expect(title()).toBe("Sign in to Office");
  });

  it("welcomes the person back to choose a new password, and signs in", async () => {
    vi.mocked(checkInviteCode).mockResolvedValue(checked("mayak"));
    vi.mocked(finishJoin).mockResolvedValue({
      token: "recovered_token",
      confirmation: "mac",
      client: { id: "macbook", kind: "personal" },
      person: maya,
    } as RedeemFinished);
    await click("Just me");
    await click("Forgot your password?");
    await type(forgotField(), "K7QXM4PD");
    expect(checkInviteCode).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "K7QXM4PD" }),
    );

    expect(title()).toBe("Welcome back, Maya Keller");
    expect(container.textContent).toContain(
      "Choose a new password. It never leaves this device.",
    );
    await fill("New password", "staple battery horse");
    await click("Sign in");
    expect(finishJoin).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "mayak",
        password: "staple battery horse",
      }),
    );
    expect(saved).toEqual([
      expect.objectContaining({ token: "recovered_token", kind: "personal" }),
    ]);
    expect(container.querySelector(".home-screen")).not.toBeNull();
  });
});

describe("a suggested username", () => {
  it("is the first name, as a username", () => {
    expect(suggestedUsername("Maya Keller")).toBe("maya");
    expect(suggestedUsername("Zoë")).toBe("zoe");
    expect(suggestedUsername("Al")).toBe("");
  });
});
