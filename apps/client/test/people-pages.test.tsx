// @vitest-environment jsdom
import type {
  ClientInfo,
  LoginInfo,
  Me,
  PersonInfo,
} from "@meetsanctum/auth-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { PeoplePage } from "../src/people/people-page";
import { PersonPage } from "../src/people/person-page";

// Settings → People and a person's page: the list says how each person
// signs in, and removing a sign-in or a person asks first, naming what
// ends, and never takes the home's last sign-in.

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
let clients: ClientInfo[];
let posted: [string, unknown][];
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  people = [alex, maya, sam];
  logins = [
    { personId: "alex", username: "alex" },
    { personId: "maya", username: "maya" },
  ];
  clients = [laptop, client({})];
  posted = [];
  vi.mocked(coreJson).mockImplementation(async (path, init) => {
    if (init?.method === "POST") {
      posted.push([path, init.json]);
      if (path === "/api/auth/logins/remove") {
        logins = logins.filter(
          (login) =>
            login.personId !== (init.json as { personId: string }).personId,
        );
      }
      return undefined as never;
    }
    if (path === "/api/people") return people as never;
    if (path === "/api/auth/logins") return logins as never;
    if (path === "/api/auth/invites") return [] as never;
    if (path === "/api/auth/clients") return clients as never;
    throw new Error(`unexpected ${path}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) =>
      each.textContent === name || each.getAttribute("aria-label") === name,
  );

describe("the People page", () => {
  it("lists everyone, says how they sign in, and marks you", async () => {
    const opened: string[] = [];
    await act(async () =>
      root.render(
        <PeoplePage page={null} me={me} onOpen={(id) => opened.push(id)} />,
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
      root.render(<PeoplePage page={null} me={tablet} onOpen={() => {}} />),
    );
    expect(container.textContent).not.toContain("You");
  });
});

describe("a person's page", () => {
  async function show(personId: string) {
    await act(async () =>
      root.render(<PersonPage personId={personId} back={() => {}} />),
    );
  }

  it("removes a sign-in after saying what ends, Cancel first", async () => {
    await show("maya");
    expect(container.textContent).toContain("Signs in as maya");

    await act(async () => button("Remove sign-in")!.click());
    const alert = document.querySelector('[role="dialog"]')!;
    expect(alert.textContent).toContain("Remove Maya Keller’s sign-in?");
    expect(alert.textContent).toContain(
      "Maya stays in People. Maya's iPhone signs out now.",
    );
    expect(document.activeElement?.textContent).toBe("Cancel");

    await act(async () =>
      [...alert.querySelectorAll("button")]
        .find((each) => each.textContent === "Remove sign-in")!
        .click(),
    );
    expect(posted).toEqual([["/api/auth/logins/remove", { personId: "maya" }]]);
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

  it("shows no devices for someone who doesn't sign in", async () => {
    await show("sam");
    expect(container.textContent).toContain("Doesn't sign in");
    expect(container.textContent).not.toContain("Devices");

    await act(async () => button("Remove Sam")!.click());
    const alert = document.querySelector('[role="dialog"]')!;
    expect(alert.textContent).toContain("To add Sam again, use Add a person.");
    expect(alert.textContent).not.toContain("sign-in ends");
  });
});
