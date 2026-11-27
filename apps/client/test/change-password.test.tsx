// @vitest-environment jsdom
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

import {
  changePassword,
  choosePassword,
  PasswordChangeError,
} from "../src/auth/password";
import { CoreError, coreJson } from "../src/core-fetch";
import { PersonPage } from "../src/people/person-page";
import { deferred } from "./deferred";

// Changing your own password from your own page: Change password takes
// Reset password's place there, the dialog checks the new password before
// anything is sent, says what went wrong beside its cause, can't be closed
// while it saves, and the page says the password changed. Forgot your
// password? chooses a new one without the current one.

vi.mock("../src/auth/password", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth/password")>()),
  changePassword: vi.fn(),
  choosePassword: vi.fn(),
}));
vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));
vi.mock("../src/people/invites", () => ({
  cancelInvite: vi.fn(),
  makeInvite: vi.fn(),
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

function client(changes: Partial<ClientInfo>): ClientInfo {
  return {
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
    ...changes,
  };
}

const laptop = client({});
const me: Me = { client: laptop, person: alex };
const logins: LoginInfo[] = [
  { personId: "alex", username: "alex" },
  { personId: "maya", username: "maya" },
];

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
    if (path === "/api/auth/invites") return invites as never;
    if (path === "/api/auth/agents") return [] as never;
    throw new Error(`unexpected ${path}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

async function show(personId = "alex", viewer: Me | undefined = me) {
  await act(async () =>
    root.render(
      <PersonPage
        live={live}
        personId={personId}
        me={viewer}
        back={() => {}}
      />,
    ),
  );
}

const buttons = () => [...document.querySelectorAll("button")];
const button = (text: string) =>
  buttons().find(
    (each) =>
      each.textContent === text || each.getAttribute("aria-label") === text,
  );
const dialog = () => document.querySelector('[role="dialog"]');

async function click(text: string) {
  const found = button(text);
  expect(found, text).toBeDefined();
  await act(async () => found!.click());
}

const setValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)!.set!;

function field(label: string) {
  const found = [...document.querySelectorAll("label")].find(
    (each) => each.textContent === label,
  )?.control as HTMLInputElement | undefined;
  expect(found, label).toBeInstanceOf(HTMLInputElement);
  return found!;
}

async function fill(label: string, value: string) {
  const input = field(label);
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

async function submit() {
  const found = dialog()?.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  );
  expect(found).toBeDefined();
  await act(async () => found!.click());
}

async function fillAll(current: string, next: string, repeated = next) {
  await fill("Current password", current);
  await fill("New password", next);
  await fill("Repeat new password", repeated);
}

const problemOf = (input: HTMLInputElement) =>
  input
    .getAttribute("aria-describedby")
    ?.split(" ")
    .map((id) => document.getElementById(id))
    .find((each) => each?.getAttribute("role") === "alert")?.textContent;

function resetCode(): InviteInfo {
  return {
    id: "reset",
    personId: alex.id,
    kind: "reset",
    ended: null,
    createdAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe("Change password", () => {
  it("takes Reset password's place on your own page only", async () => {
    await show();
    expect(button("Change password")).toBeDefined();
    expect(button("Reset password")).toBeUndefined();
    expect(container.textContent).toContain(
      "You stay in People but can’t sign in. Your devices sign out at once.",
    );

    await show("maya");
    expect(button("Change password")).toBeUndefined();
    expect(button("Reset password")).toBeDefined();
  });

  it("offers Change password and Cancel code on your own page with an active reset code", async () => {
    invites = [resetCode()];
    await show();
    expect(button("Change password")).toBeDefined();
    expect(button("Cancel code")).toBeDefined();
    expect(button("Reset password")).toBeUndefined();
  });

  it("isn't offered on a shared device, which is no one's", async () => {
    await show("alex", {
      client: client({ id: "tablet", kind: "shared", personId: null }),
      person: null,
    });
    expect(button("Change password")).toBeUndefined();
    expect(button("Reset password")).toBeDefined();
  });

  it("checks the new password on this device first", async () => {
    await show();
    await click("Change password");
    expect(dialog()?.textContent).toContain("Change your password");
    expect(document.activeElement).toBe(field("Current password"));

    await fillAll("old password", "short");
    await submit();
    expect(problemOf(field("New password"))).toBe("Use at least 8 characters.");
    // The problem takes the hint's place.
    expect(dialog()?.textContent).not.toContain("At least 8 characters.");

    await fillAll("old password", "staple battery horse", "staple battery");
    await submit();
    expect(problemOf(field("Repeat new password"))).toBe(
      "Enter the same password twice.",
    );
    await fill("New password", "staple battery");
    expect(problemOf(field("Repeat new password"))).toBeUndefined();
    expect(
      field("Repeat new password").getAttribute("aria-invalid"),
    ).toBeNull();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("opens with empty fields and no error after cancelling an attempt", async () => {
    await show();
    await click("Change password");
    await fillAll("old password", "staple battery horse", "staple battery");
    await submit();
    expect(problemOf(field("Repeat new password"))).toBeDefined();

    await click("Cancel");
    expect(dialog()).toBeNull();
    await click("Change password");
    expect(field("Current password").value).toBe("");
    expect(field("New password").value).toBe("");
    expect(field("Repeat new password").value).toBe("");
    expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
  });

  it("aborts a pending password change when you leave the page", async () => {
    const saving = deferred<void>();
    vi.mocked(changePassword).mockReturnValue(saving.promise);
    await show();
    await click("Change password");
    await fillAll("old password", "staple battery horse");
    await submit();
    const signal = vi.mocked(changePassword).mock.calls[0]![0].signal!;
    expect(signal.aborted).toBe(false);

    await show("maya");
    expect(dialog()).toBeNull();
    expect(signal.aborted).toBe(true);
    await act(async () => saving.resolve());
    expect(container.textContent).not.toContain("Changed just now");
  });

  it("keeps a wrong current password, selected, and says so beside it", async () => {
    vi.mocked(changePassword).mockRejectedValue(
      new PasswordChangeError("wrong_password"),
    );
    await show();
    await click("Change password");
    await fillAll("not my password", "staple battery horse");
    await submit();
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    const current = field("Current password");
    expect(problemOf(current)).toBe(
      "That password doesn’t match. Check it and try again.",
    );
    expect(current.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(current);
    expect(current.selectionStart).toBe(0);
    expect(current.selectionEnd).toBe("not my password".length);
    expect(field("New password").value).toBe("staple battery horse");
  });

  it("says what went wrong above the buttons when it isn't a field's fault", async () => {
    vi.mocked(changePassword).mockRejectedValue(
      new CoreError(429, "too_many_attempts"),
    );
    await show();
    await click("Change password");
    await fillAll("old password", "staple battery horse");
    await submit();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Too many attempts from this device. Try again in 15 minutes.",
    );
  });

  it("restores the form and explains what to do if the change is unconfirmed", async () => {
    vi.mocked(changePassword).mockRejectedValue(
      new PasswordChangeError("unconfirmed"),
    );
    await show();
    await click("Change password");
    await fillAll("old password", "staple battery horse");
    await submit();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn’t confirm the password change. Check whether your new password works before trying again.",
    );
    expect(button("Cancel")?.disabled).toBe(false);
    expect(button("Close")).toBeDefined();
  });

  it("can't be closed while it saves, then says the password changed", async () => {
    const saving = deferred<void>();
    vi.mocked(changePassword).mockReturnValue(saving.promise);
    await show();
    const trigger = button("Change password")!;
    await act(async () => trigger.click());
    await fillAll("old password", "staple battery horse");
    await act(async () =>
      dialog()!
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true })),
    );

    expect(changePassword).toHaveBeenCalledWith(
      expect.objectContaining({
        current: "old password",
        next: "staple battery horse",
      }),
    );
    expect(dialog()?.textContent).toContain("Changing…");
    expect(button("Cancel")?.disabled).toBe(true);
    expect(button("Close")).toBeUndefined();
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(dialog()).not.toBeNull();

    await act(async () => saving.resolve());
    expect(dialog()).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Changed just now",
    );
    // The dialog hands focus back once it has gone.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement).toBe(button("Change password"));
  });
});

describe("Forgot your password?", () => {
  it("chooses a new password without the current one", async () => {
    vi.mocked(choosePassword).mockResolvedValue();
    await show();
    await click("Change password");
    await click("Forgot your password?");
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));

    expect(dialog()?.querySelector("h2")?.textContent).toBe(
      "Choose a new password",
    );
    expect(dialog()?.textContent).toContain(
      "This device is signed in as you, so you don’t need your old password.",
    );
    expect(
      [...document.querySelectorAll("label")].map((each) => each.textContent),
    ).not.toContain("Current password");
    expect(document.activeElement).toBe(field("New password"));

    await fill("New password", "staple battery horse");
    await fill("Repeat new password", "staple battery horse");
    await submit();

    expect(choosePassword).toHaveBeenCalledWith(
      expect.objectContaining({ next: "staple battery horse" }),
    );
    expect(changePassword).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Changed just now",
    );
  });

  it("reads the page again, as a waiting code for a new password ended", async () => {
    invites = [resetCode()];
    vi.mocked(choosePassword).mockImplementation(async () => {
      invites = [];
    });
    await show();
    expect(button("Cancel code")).toBeDefined();
    await click("Change password");
    await click("Forgot your password?");
    await fill("New password", "staple battery horse");
    await fill("Repeat new password", "staple battery horse");
    await submit();

    expect(button("Cancel code")).toBeUndefined();
  });

  it("asks for the current password again next time", async () => {
    await show();
    await click("Change password");
    await click("Forgot your password?");
    await click("Cancel");
    await click("Change password");

    expect(dialog()?.querySelector("h2")?.textContent).toBe(
      "Change your password",
    );
    expect(field("Current password").value).toBe("");
    expect(button("Forgot your password?")).toBeDefined();
  });
});
