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

import { CoreError, coreJson } from "../src/core-fetch";
import { cancelInvite, makeInvite } from "../src/people/invites";
import { PeoplePage } from "../src/people/people-page";
import { PersonPage } from "../src/people/person-page";
import { entry } from "./activity-fixtures";
import { deferred } from "./deferred";

// Settings → People and a person's page: the list says how each person
// signs in, and removing a sign-in or a person asks first, naming what
// ends, and never takes the home's last sign-in.

vi.mock("../src/people/invites", () => ({
  makeInvite: vi.fn(),
  cancelInvite: vi.fn(),
}));
vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
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
const sam: PersonInfo = {
  id: "sam",
  name: "Sam",
  avatar: null,
  colour: "#fcd2b3",
};

function client(changes: Partial<ClientInfo>): ClientInfo {
  return {
    id: "phone",
    name: "Maya's iPhone",
    kind: "personal",
    platform: "ios",
    personId: "maya",
    createdAt: "2026-11-01T10:00:00Z",
    lastSeenAt: new Date().toISOString(),
    connectedSince: null,
    current: false,
    reduceEffects: false,
    reduceMotion: false,
    ...changes,
  };
}

const laptop = client({
  id: "laptop",
  name: "Alex's MacBook",
  personId: "alex",
  current: true,
});
const me: Me = { client: laptop, person: alex };

let people: PersonInfo[];
let logins: LoginInfo[];
let invites: InviteInfo[];
let clients: ClientInfo[];
let clientsUnavailable: boolean;
let removeLoginError: CoreError | undefined;
let pendingSave: Promise<void> | undefined;
let posted: [string, unknown][];
let container: HTMLDivElement;
let root: Root;
const live = createLiveFeed();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
    },
  );
  people = [alex, maya, sam];
  logins = [
    { personId: "alex", username: "alex" },
    { personId: "maya", username: "maya" },
  ];
  clients = [laptop, client({})];
  invites = [];
  clientsUnavailable = false;
  removeLoginError = undefined;
  pendingSave = undefined;
  posted = [];
  vi.mocked(coreJson).mockImplementation(async (path, init) => {
    if (init?.method === "POST") {
      posted.push([path, init.json]);
      if (path === "/api/auth/logins/remove") {
        if (removeLoginError) throw removeLoginError;
        const { personId } = init.json as { personId: string };
        logins = logins.filter((login) => login.personId !== personId);
        clients = clients.filter((device) => device.personId !== personId);
      }
      if (path === "/api/people/remove") {
        const { id } = init.json as { id: string };
        people = people.filter((person) => person.id !== id);
      }
      if (path === "/api/people/update") {
        const changes = init.json as {
          id: string;
          name: string;
          colour: string;
        };
        people = people.map((person) =>
          person.id === changes.id ? { ...person, ...changes } : person,
        );
        await pendingSave;
        return people.find((person) => person.id === changes.id) as never;
      }
      if (path === "/api/auth/clients/revoke") {
        const { id } = init.json as { id: string };
        clients = clients.filter((device) => device.id !== id);
      }
      return undefined as never;
    }
    if (path === "/api/people") return people as never;
    if (path === "/api/auth/logins") return logins as never;
    if (path.startsWith("/api/auth/invites")) return invites as never;
    if (path === "/api/auth/agents") {
      return [
        {
          id: "claude",
          name: "Claude",
          platform: "macos",
          addedBy: { kind: "person", id: "maya", name: "Maya Keller" },
          createdAt: "2026-11-20T10:00:00Z",
          lastSeenAt: null,
        },
      ] as never;
    }
    if (path === "/api/auth/clients") {
      if (clientsUnavailable) throw new Error("The device list is unavailable");
      return clients as never;
    }
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
});

const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) =>
      each.textContent === name || each.getAttribute("aria-label") === name,
  );

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const confirm = (name: string) =>
  act(async () =>
    [...dialog().querySelectorAll<HTMLButtonElement>("button")]
      .find((each) => each.textContent === name)!
      .click(),
  );

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

function editName(field: HTMLInputElement, name: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(field, name);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the People page", () => {
  it("lists everyone, says how they sign in, and marks you", async () => {
    const opened: string[] = [];
    await act(async () =>
      root.render(
        <PeoplePage
          page={null}
          live={live}
          me={me}
          onOpen={(id) => opened.push(id)}
        />,
      ),
    );

    const rows = [
      ...container.querySelectorAll<HTMLButtonElement>(
        "#settings-people button",
      ),
    ].map((row) => row.getAttribute("aria-label"));
    expect(rows).toEqual([
      "Alex Keller, you: Signs in",
      "Maya Keller: Signs in",
      "Sam: Doesn't sign in",
    ]);
    await act(async () => button("Sam: Doesn't sign in")!.click());
    expect(opened).toEqual(["sam"]);
  });

  it("marks nobody on a shared device", async () => {
    const tablet: Me = {
      client: client({ id: "kitchen", kind: "shared", personId: null }),
      person: null,
    };
    await act(async () =>
      root.render(
        <PeoplePage page={null} live={live} me={tablet} onOpen={() => {}} />,
      ),
    );
    expect(container.textContent).not.toContain("You");
  });

  it("reads again with the shell's refresh, without the device list", async () => {
    clientsUnavailable = true;
    vi.mocked(coreJson).mockClear();
    await act(async () =>
      root.render(<PeoplePage page={null} live={live} onOpen={() => {}} />),
    );
    expect(button("Maya Keller: Signs in")).toBeDefined();

    logins = logins.filter(({ personId }) => personId !== "maya");
    await act(async () => live.refresh());

    expect(button("Maya Keller: Doesn't sign in")).toBeDefined();
    expect(vi.mocked(coreJson).mock.calls.map(([path]) => path)).not.toContain(
      "/api/auth/clients",
    );
  });

  it("returns focus to Add a person after cancelling", async () => {
    await act(async () =>
      root.render(<PeoplePage page={null} live={live} onOpen={() => {}} />),
    );
    const trigger = button("Add a person")!;
    trigger.focus();
    await act(async () => trigger.click());
    await confirm("Cancel");
    await act(nextTick);
    expect(document.activeElement).toBe(trigger);
  });
});

describe("a person's page", () => {
  async function show(personId: string, back = vi.fn()) {
    await act(async () =>
      root.render(<PersonPage live={live} personId={personId} back={back} />),
    );
  }

  it("removes a sign-in after saying what ends, Cancel first", async () => {
    invites = [
      {
        id: "reset",
        personId: "maya",
        kind: "reset",
        ended: null,
        createdAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    await show("maya");
    expect(container.textContent).toContain("Usernamemaya");
    expect(container.textContent).toContain("Password codeWorks until");
    expect(container.textContent).toContain(
      "Maya stays in People but can’t sign in. Maya’s devices sign out at once.",
    );

    await act(async () => button("Remove sign-in")!.click());
    const alert = document.querySelector('[role="dialog"]')!;
    expect(alert.textContent).toContain("Remove Maya Keller’s sign-in?");
    expect(alert.textContent).toContain(
      "Maya stays in People. Maya's iPhone signs out now.",
    );
    expect(alert.textContent).toContain("The password code stops working.");
    expect(alert.textContent).toContain(
      "Any saved recovery code stops working.",
    );
    expect(document.activeElement?.textContent).toBe("Cancel");

    await confirm("Remove sign-in");
    expect(posted).toEqual([["/api/auth/logins/remove", { personId: "maya" }]]);
  });

  it("returns focus to Remove sign-in after cancelling", async () => {
    await show("maya");
    const trigger = button("Remove sign-in")!;
    trigger.focus();
    await act(async () => trigger.click());
    await confirm("Cancel");
    await act(nextTick);
    expect(document.activeElement).toBe(trigger);
  });

  it("shows the last sign-in refusal in the open confirmation", async () => {
    await show("maya");
    await act(async () => button("Remove sign-in")!.click());
    removeLoginError = new CoreError(409, "last_login");
    await confirm("Remove sign-in");
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
      "Maya Keller is the only person who signs in, so this sign-in stays.",
    );
  });

  it("offers to retry the read when removing a sign-in succeeds but refreshing fails", async () => {
    await show("maya");
    await act(async () => button("Remove sign-in")!.click());
    clientsUnavailable = true;
    await confirm("Remove sign-in");

    expect(dialog()).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "out of date",
    );
    expect(button("Remove sign-in")?.disabled).toBe(true);

    clientsUnavailable = false;
    await act(async () => button("Retry")!.click());
    expect(container.textContent).toContain("Doesn't sign in");
    expect(button("Remove sign-in")).toBeUndefined();
    expect(posted).toHaveLength(1);
  });

  it("saves the edited name and colour and reads them back", async () => {
    await show("maya");
    const field =
      container.querySelector<HTMLInputElement>("input[maxlength]")!;
    await act(async () => editName(field, "  Maya Lee  "));
    await act(async () => button("Lavender")!.click());
    await act(async () => button("Save")!.click());

    expect(posted).toEqual([
      [
        "/api/people/update",
        { id: "maya", name: "Maya Lee", colour: "#dbcaf5" },
      ],
    ]);
    expect(container.textContent).toContain("Maya Lee");
    expect(
      container.querySelector<HTMLInputElement>("input[maxlength]")?.value,
    ).toBe("Maya Lee");
    expect(button("Lavender")?.getAttribute("aria-checked")).toBe("true");
    expect(button("Save")?.disabled).toBe(true);
  });

  it("signs out only the selected device", async () => {
    clients.push(client({ id: "ipad", name: "Maya's iPad" }));
    await show("maya");
    await act(async () => button("Sign out Maya's iPhone")!.click());
    await confirm("Sign out");

    expect(posted).toEqual([["/api/auth/clients/revoke", { id: "phone" }]]);
    expect(button("Sign out Maya's iPhone")).toBeUndefined();
    expect(button("Sign out Maya's iPad")).toBeDefined();
  });

  it("keeps the name and colour disabled while a save is in progress", async () => {
    let completeSave!: () => void;
    pendingSave = new Promise<void>((resolve) => {
      completeSave = resolve;
    });
    await show("maya");
    const name = () =>
      container.querySelector<HTMLInputElement>("input[maxlength]")!;
    await act(async () => editName(name(), "Maya Lee"));
    await act(async () => button("Save")!.click());

    await act(async () =>
      live.publish({
        type: "activity",
        entry: entry({ source: "people", action: "person.update" }),
      }),
    );
    expect(container.textContent).toContain("Maya Lee");
    expect(name().disabled).toBe(true);
    expect(button("Lavender")?.disabled).toBe(true);

    await act(async () => completeSave());
    expect(name().disabled).toBe(false);
    expect(button("Lavender")?.disabled).toBe(false);
  });

  it("keeps the home's last sign-in, and says why", async () => {
    logins = [{ personId: "alex", username: "alex" }];
    await show("alex");

    expect(button("Remove sign-in")!.disabled).toBe(true);
    expect(button("Remove Alex Keller")!.disabled).toBe(true);
    expect(container.textContent).toContain(
      "Alex Keller is the only person who signs in, so this sign-in stays.",
    );
  });

  it("removes a person and goes back after saying what ends", async () => {
    invites = [
      {
        id: "invite",
        personId: "sam",
        kind: "invite",
        ended: null,
        createdAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    const back = vi.fn();
    await show("sam", back);
    expect(container.textContent).toContain("InviteWorks until");
    expect(container.textContent).toContain("Sam leaves People.");
    expect(container.textContent).not.toContain("Devices");

    await act(async () => button("Remove Sam")!.click());
    const alert = document.querySelector('[role="dialog"]')!;
    expect(alert.textContent).toContain("To add Sam again, use Add a person.");
    expect(alert.textContent).not.toContain("AI agent");
    expect(alert.textContent).toContain("The invite code stops working.");
    expect(alert.textContent).not.toContain("sign-in ends");
    await confirm("Remove");

    expect(posted).toEqual([["/api/people/remove", { id: "sam" }]]);
    expect(back).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("Sam");
  });

  it("says a saved recovery code ends when removing a person who signs in", async () => {
    await show("maya");
    await act(async () => button("Remove Maya Keller")!.click());
    expect(dialog().textContent).toContain(
      "Any saved recovery code stops working.",
    );
  });
});

describe("inviting someone to sign in", () => {
  async function show(personId: string, ask = false) {
    await act(async () =>
      root.render(
        <PersonPage
          live={live}
          personId={personId}
          ask={ask}
          back={() => {}}
        />,
      ),
    );
  }

  const made = {
    code: "K7QXM4PD",
    info: {
      id: "invite",
      personId: "sam",
      kind: "invite",
      createdAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      ended: null,
    },
  } satisfies Awaited<ReturnType<typeof makeInvite>>;

  beforeEach(() => {
    vi.mocked(makeInvite).mockReset().mockResolvedValue(made);
    vi.mocked(cancelInvite).mockReset();
  });

  it("shows the code once, with the steps on the person's device", async () => {
    await show("sam");
    await act(async () => button("Invite to sign in")!.click());
    await act(nextTick);

    expect(makeInvite).toHaveBeenCalledWith(
      { personId: "sam", kind: "invite" },
      expect.any(AbortSignal),
    );
    expect(dialog().textContent).toContain("Invite Sam to sign in");
    expect(dialog().textContent).toContain("K7QX-M4PD");
    expect(dialog().textContent).toContain(
      "You can’t see it again after you close this.",
    );
    expect(dialog().textContent).toContain(
      "On Sam’s Mac, open Sanctum and choose your home.",
    );
    expect(dialog().textContent).toContain(
      "Choose Just me, then I have an invite code.",
    );
    await confirm("Done");
    await act(nextTick);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("asks whether someone just added will sign in, and Not now makes no code", async () => {
    await show("sam", true);
    await act(nextTick);
    expect(dialog().textContent).toContain("Will Sam sign in?");
    await confirm("Not now");
    expect(makeInvite).not.toHaveBeenCalled();
  });

  it("explains what replacing an active invite does before making a code", async () => {
    invites = [made.info];
    await show("sam");
    await act(async () => button("New invite code")!.click());
    expect(dialog().textContent).toContain(
      "The previous code will stop working",
    );
    expect(makeInvite).not.toHaveBeenCalled();
    await confirm("Cancel");
    expect(makeInvite).not.toHaveBeenCalled();
    await act(async () => button("New invite code")!.click());
    await confirm("Make new code");
    expect(makeInvite).toHaveBeenCalledWith(
      { personId: "sam", kind: "invite", replacesInviteId: "invite" },
      expect.any(AbortSignal),
    );
    expect(dialog().textContent).toContain("K7QX-M4PD");
  });

  it.each([
    { personId: "sam", kind: "invite", label: "Cancel invite" },
    { personId: "maya", kind: "reset", label: "Cancel code" },
  ] as const)(
    "confirms before cancelling a $kind code",
    async ({ personId, kind, label }) => {
      invites = [{ ...made.info, personId, kind }];
      await show(personId);
      await act(async () => button(label)!.click());
      expect(dialog().textContent).toContain("code stops working");
      expect(cancelInvite).not.toHaveBeenCalled();
      await confirm(label);
      expect(cancelInvite).toHaveBeenCalledWith(personId, made.info.id);
    },
  );

  it("refreshes when the code shown for cancellation has been replaced", async () => {
    invites = [made.info];
    vi.mocked(cancelInvite).mockRejectedValue(
      new CoreError(409, "invite_changed"),
    );
    await show("sam");
    await act(async () => button("Cancel invite")!.click());
    invites = [{ ...made.info, id: "replacement" }];
    await confirm("Cancel invite");
    expect(cancelInvite).toHaveBeenLastCalledWith("sam", "invite");
    expect(dialog().textContent).toContain("This code is no longer active.");
    await confirm("Cancel");
    await act(async () => button("Cancel invite")!.click());
    await confirm("Cancel invite");
    expect(cancelInvite).toHaveBeenLastCalledWith("sam", "replacement");
  });

  it("refreshes when the person's sign-in has changed", async () => {
    vi.mocked(makeInvite).mockImplementationOnce(async () => {
      logins.push({ personId: "sam", username: "sam" });
      throw new CoreError(409, "invite_kind_changed");
    });
    await show("sam");
    await act(async () => button("Invite to sign in")!.click());
    expect(dialog().textContent).toContain("Sam’s sign-in has changed.");
    await confirm("Done");
    expect(button("Reset password")).toBeDefined();
  });

  it("keeps the dialog open while making the code", async () => {
    const making = deferred<typeof made>();
    vi.mocked(makeInvite).mockReturnValueOnce(making.promise);
    await show("sam");
    await act(async () => button("Invite to sign in")!.click());
    expect(button("Done")).toBeUndefined();
    expect(button("Close")).toBeUndefined();
    await act(nextTick);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      document
        .querySelector('[data-slot="dialog-overlay"]')!
        .dispatchEvent(
          new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
        );
    });
    expect(dialog().textContent).toContain("Making a code");
    await act(async () => making.resolve(made));
    expect(dialog().textContent).toContain("K7QX-M4PD");
    expect(button("Done")).toBeDefined();
  });

  it("selects the visible code for manual copying when the clipboard refuses", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Clipboard denied"));
    vi.stubGlobal("navigator", {
      userAgent: navigator.userAgent,
      clipboard: { writeText },
    });
    await show("sam");
    await act(async () => button("Invite to sign in")!.click());
    await confirm("Copy code");
    expect(writeText).toHaveBeenCalledWith("K7QX-M4PD");
    expect(dialog().textContent).toContain("Copy it manually");
    expect(window.getSelection()?.toString()).toBe("K7QX-M4PD");
  });

  it("ignores a clipboard result from an earlier code", async () => {
    const copying = deferred<void>();
    const writeText = vi.fn(() => copying.promise);
    vi.stubGlobal("navigator", {
      userAgent: navigator.userAgent,
      clipboard: { writeText },
    });
    vi.mocked(makeInvite)
      .mockResolvedValueOnce(made)
      .mockResolvedValueOnce({
        ...made,
        code: "X7QXM4PD",
      });
    await show("sam");
    await act(async () => button("Invite to sign in")!.click());
    await confirm("Copy code");
    await confirm("Done");
    await act(async () => button("Invite to sign in")!.click());
    expect(dialog().textContent).toContain("X7QX-M4PD");
    await act(async () => copying.resolve());
    expect(button("Copy code")).toBeDefined();
    expect(button("Copied")).toBeUndefined();
  });
});
