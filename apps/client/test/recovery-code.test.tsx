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
import { makeInvite } from "../src/people/invites";
import { PersonPage } from "../src/people/person-page";
import { printRecoveryCode, recoverySheet } from "../src/people/print-recovery";

// A recovery code: a row on your own Sign-In card only, a dialog that shows
// the code once with Copy code and Print, and a step right after setting up
// a home that offers one, which Continue never waits on.

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

function recoveryCode(createdAt = new Date().toISOString()): InviteInfo {
  return {
    id: "recovery",
    personId: alex.id,
    kind: "recovery",
    ended: null,
    createdAt,
    endsAt: "2126-11-01T10:00:00Z",
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
    if (path === "/api/auth/invites") return invites as never;
    if (path === "/api/auth/agents") return [] as never;
    throw new Error(`unexpected ${path}`);
  });
  vi.mocked(makeInvite).mockResolvedValue({
    code: "K7QXM4PD",
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
  vi.resetAllMocks();
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
      "K7QX-M4PD",
    );
    await click("Print");
    expect(printRecoveryCode).toHaveBeenCalledWith(
      expect.objectContaining({
        person: alex.name,
        username: "alex",
        code: "K7QX-M4PD",
      }),
    );
  });

  it("says a new code ends the earlier one", async () => {
    invites = [recoveryCode()];
    await show();
    expect(container.textContent).toContain("Made today");
    await click("Make a new code");

    expect(dialog()?.querySelector("h2")?.textContent).toBe(
      "Your new recovery code",
    );
    expect(dialog()?.textContent).toContain(
      "Your earlier code no longer works.",
    );
  });
});

describe("the printed page", () => {
  it("has the person, username, code and how to use it, and escapes them", () => {
    const sheet = recoverySheet({
      clock: homeClock({ timeZone: "Europe/Berlin" }),
      person: "Alex <Keller>",
      username: "alex",
      code: "K7QX-M4PD",
      madeAt: "2026-11-27T10:00:00Z",
    });
    expect(sheet).toContain("Alex &lt;Keller&gt;");
    expect(sheet).toContain("K7QX-M4PD");
    expect(sheet).toContain("Choose Just me, then Forgot your password?");
    expect(sheet).toContain(
      "Anyone with it can choose a new password for you.",
    );
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
});
