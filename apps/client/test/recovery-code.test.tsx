// @vitest-environment jsdom
import { homeClock } from "@meetsanctum/app-sdk/clock";
import type {
  ClientInfo,
  InviteInfo,
  LoginInfo,
  Me,
  PersonInfo,
} from "@meetsanctum/auth-protocol";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SaveRecovery } from "../src/auth/SaveRecovery";
import { coreJson } from "../src/core-fetch";
import { cancelInvite, makeInvite } from "../src/people/invites";
import { PersonPage } from "../src/people/person-page";
import { printRecoveryCode, recoverySheet } from "../src/people/print-recovery";
import { deferred } from "./deferred";

// A recovery code: a row on your own Sign-In card only, a dialog that shows
// the code once with Copy code and Print, and a step right after setting up
// a home where Continue is available while the code is being made.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));
vi.mock("../src/people/invites", () => ({
  cancelInvite: vi.fn(),
  makeInvite: vi.fn(),
}));
vi.mock("../src/people/print-recovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/people/print-recovery")>()),
  printRecoveryCode: vi.fn(),
}));

const alex: PersonInfo = {
  id: "alex",
  name: "Alex Keller",
  avatar: null,
  colour: "#c5cdac",
};
const maya: PersonInfo = {
  id: "maya",
  name: "Maya Keller",
  avatar: null,
  colour: "#b9defc",
};
const laptop: ClientInfo = {
  id: "laptop",
  name: "Alex's MacBook",
  kind: "personal",
  platform: "macos",
  personId: "alex",
  createdAt: "2026-11-01T10:00:00Z",
  lastSeenAt: new Date().toISOString(),
  connectedSince: null,
  current: true,
  reduceEffects: false,
  reduceMotion: false,
};
const me: Me = { client: laptop, person: alex };
const logins: LoginInfo[] = [
  { personId: "alex", username: "alex" },
  { personId: "maya", username: "maya" },
];
const code = "K7QXM4PDW8RTV2ZN";
const formattedCode = "K7QX-M4PD-W8RT-V2ZN";

function recoveryCode(createdAt = new Date().toISOString()): InviteInfo {
  return {
    id: "recovery",
    personId: alex.id,
    kind: "recovery",
    ended: null,
    createdAt,
    endsAt: null,
  };
}

let container: HTMLDivElement;
let root: Root;
let invites: InviteInfo[];
const live = createLiveFeed();

beforeEach(() => {
  invites = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
    },
  );
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path === "/api/people") return [alex, maya] as never;
    if (path === "/api/auth/logins") return logins as never;
    if (path === "/api/auth/clients") return [laptop] as never;
    if (path === "/api/auth/invites?includeRecovery=true")
      return invites as never;
    if (path === "/api/auth/agents") return [] as never;
    throw new Error(`unexpected ${path}`);
  });
  vi.mocked(makeInvite).mockResolvedValue({
    code,
    info: recoveryCode(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.useRealTimers();
});

async function show(personId = "alex") {
  await act(async () =>
    root.render(
      <PersonPage live={live} personId={personId} me={me} back={() => {}} />,
    ),
  );
}

const button = (text: string) =>
  [...document.querySelectorAll("button")].find(
    (each) => each.textContent === text,
  );
const dialog = () => document.querySelector('[role="dialog"]');

async function click(text: string) {
  const found = button(text);
  expect(found, text).toBeDefined();
  await act(async () => found!.click());
}

describe("your recovery code", () => {
  it("is a row on your own page only", async () => {
    await show();
    expect(container.textContent).toContain(
      "Lets you back in if you forget your password",
    );
    expect(button("Make a code")).toBeDefined();

    await show("maya");
    expect(container.textContent).not.toContain("Recovery code");
  });

  it("is made on this device and shown once, with Copy code and Print", async () => {
    await show();
    await click("Make a code");

    expect(makeInvite).toHaveBeenCalledWith(
      expect.objectContaining({ personId: alex.id, kind: "recovery" }),
      expect.any(AbortSignal),
    );
    expect(dialog()?.querySelector("h2")?.textContent).toBe(
      "Your recovery code",
    );
    expect(dialog()?.textContent).toContain(
      "If you forget your password, this code lets you choose a new one.",
    );
    expect(dialog()?.textContent).not.toContain("Your earlier code");
    // The boxes show the code; its text is only for screen readers.
    expect(dialog()?.querySelector(".sr-only")?.textContent).toContain(
      formattedCode,
    );
    const slots = dialog()!.querySelectorAll('[data-slot="input-otp-slot"]');
    expect([...slots].map((slot) => slot.textContent).join("")).toBe(code);
    await click("Print");
    expect(printRecoveryCode).toHaveBeenCalledWith(
      expect.objectContaining({
        person: alex.name,
        username: "alex",
        code: formattedCode,
      }),
    );
  });

  it("asks before replacing a saved code", async () => {
    vi.setSystemTime(new Date(2026, 10, 27, 12));
    invites = [recoveryCode()];
    await show();
    expect(container.textContent).toContain("Made today");
    await click("Make a new code");

    expect(makeInvite).not.toHaveBeenCalled();
    expect(dialog()?.querySelector("h2")?.textContent).toBe(
      "Replace your recovery code?",
    );
    expect(dialog()?.textContent).toContain(
      "The previous code will stop working as soon as the new one is made.",
    );
    await click("Cancel");
    expect(makeInvite).not.toHaveBeenCalled();
    await click("Make a new code");
    await click("Make new code");

    expect(makeInvite).toHaveBeenCalledWith(
      { personId: alex.id, kind: "recovery", replacesInviteId: invites[0]!.id },
      expect.any(AbortSignal),
    );
    expect(dialog()?.querySelector("h2")?.textContent).toBe(
      "Your new recovery code",
    );
    expect(dialog()?.textContent).toContain(
      "Your earlier code no longer works.",
    );
  });

  it("asks before removing a saved code and then offers to make one", async () => {
    invites = [recoveryCode()];
    await show();
    await click("Remove recovery code");
    expect(dialog()?.textContent).toContain("The recovery code stops working.");
    expect(cancelInvite).not.toHaveBeenCalled();
    vi.mocked(cancelInvite).mockImplementationOnce(async () => {
      invites = [{ ...invites[0]!, ended: "cancelled" }];
    });
    await click("Remove code");
    expect(cancelInvite).toHaveBeenCalledExactlyOnceWith(
      alex.id,
      "recovery",
      "recovery",
    );
    expect(button("Make a code")).toBeDefined();
    expect(button("Remove recovery code")).toBeUndefined();
  });

  it("copies the formatted code and confirms it was copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      await show();
      await click("Make a code");
      await click("Copy code");
      expect(writeText).toHaveBeenCalledExactlyOnceWith(formattedCode);
      expect(button("Copied")).toBeDefined();
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("does not schedule an expiry refresh for a saved recovery code", async () => {
    vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
    invites = [recoveryCode("2026-11-06T12:00:00Z")];
    const timeout = vi.spyOn(globalThis, "setTimeout");
    await show();
    expect(button("Make a new code")).toBeDefined();
    expect(
      timeout.mock.calls.some(([, delay]) => (delay ?? 0) > 2 ** 31 - 1),
    ).toBe(false);
  });
});

describe("the printed page", () => {
  it("has the person, username, code and how to use it, and escapes them", () => {
    const sheet = recoverySheet({
      clock: homeClock({ timeZone: "Europe/Berlin" }),
      person: "Alex <Keller>",
      username: "alex",
      code: formattedCode,
      madeAt: "2026-11-27T10:00:00Z",
    });
    expect(sheet).toContain("Alex &lt;Keller&gt;");
    const page = new DOMParser().parseFromString(sheet, "text/html");
    expect(page.querySelector(".code")?.textContent).toBe(formattedCode);
    expect(sheet).toContain("27 November 2026");
    expect(sheet).toContain("Choose Just me, then Forgot your password?");
    expect(sheet).toContain(
      "Anyone with it can choose a new password for you.",
    );
    expect(sheet).toContain("Restoring a backup also invalidates this code.");
  });

  it("prints the generated page and removes it when printing ends", async () => {
    const { printRecoveryCode: print } = await vi.importActual<
      typeof import("../src/people/print-recovery")
    >("../src/people/print-recovery");
    const append = document.body.append.bind(document.body);
    const printPage = vi.fn();
    vi.spyOn(document.body, "append").mockImplementationOnce((...nodes) => {
      append(...nodes);
      const frame = nodes[0] as HTMLIFrameElement;
      const page = frame.contentWindow!;
      vi.spyOn(page, "focus").mockImplementation(() => {});
      vi.spyOn(page, "print").mockImplementation(() => {
        printPage(page.document.querySelector(".code")?.textContent);
      });
    });

    print({
      clock: homeClock({ timeZone: "Europe/Berlin" }),
      person: alex.name,
      username: "alex",
      code: formattedCode,
      madeAt: "2026-11-27T10:00:00Z",
    });

    expect(printPage).toHaveBeenCalledExactlyOnceWith(formattedCode);
    const frame = document.body.querySelector("iframe")!;
    frame.contentWindow!.dispatchEvent(new Event("afterprint"));
    expect(frame.isConnected).toBe(false);
  });
});

describe("saving a recovery code after setting up a home", () => {
  async function render(onContinue = vi.fn()) {
    await act(async () =>
      root.render(
        <SaveRecovery
          personId={alex.id}
          person={alex.name}
          username="alex"
          onContinue={onContinue}
        />,
      ),
    );
    return onContinue;
  }

  it("shows a new code and continues", async () => {
    const onContinue = await render();

    expect(container.querySelector("h1")?.textContent).toBe(
      "Save a recovery code",
    );
    expect(makeInvite).toHaveBeenCalledWith(
      { personId: alex.id, kind: "recovery" },
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(button("Print")).toBeDefined();
    await click("Continue");
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("continues without a code it couldn't make, and says where to make one", async () => {
    vi.mocked(makeInvite).mockRejectedValue(new Error("offline"));
    const onContinue = await render();

    expect(container.textContent).toContain(
      "The code couldn’t be made. You can make one on your page in Settings → People.",
    );
    expect(button("Print")).toBeUndefined();
    await click("Continue");
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("continues and cancels the request while code creation is still pending", async () => {
    vi.mocked(makeInvite).mockReturnValue(new Promise(() => {}));
    const onContinue = await render();
    const signal = vi.mocked(makeInvite).mock.calls[0]![1]!;

    expect(container.textContent).toContain("Making a code…");
    expect(signal.aborted).toBe(false);
    await click("Continue");
    expect(onContinue).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(true);
  });

  it("allows continuing after saving the code fails", async () => {
    const finish = deferred<void>();
    vi.mocked(makeInvite).mockImplementationOnce(
      async (_target, _signal, onSaving) => {
        onSaving?.();
        await finish.promise;
        throw new Error("offline");
      },
    );
    const onContinue = await render();
    await click("Continue");
    expect(onContinue).not.toHaveBeenCalled();
    await act(async () => finish.resolve());
    expect(container.textContent).toContain("The code couldn’t be made.");
    await click("Continue");
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("announces the manual-copy fallback when clipboard access fails", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    try {
      await render();
      await click("Copy code");

      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        "Couldn’t copy the code. Copy it manually from the text above.",
      );
      expect(window.getSelection()?.toString()).toBe(formattedCode);
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
      window.getSelection()?.removeAllRanges();
    }
  });
});
