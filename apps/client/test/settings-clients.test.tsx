// @vitest-environment jsdom
import type { ClientInfo } from "@meetsanctum/auth-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreError, coreJson } from "../src/core-fetch";
import {
  ClientsSection,
  clientDetail,
  seenText,
} from "../src/settings-clients";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const now = new Date("2026-10-28T12:00:00Z");
const maya = {
  id: "maya",
  name: "Maya",
  avatar: null,
  colour: "#c5cdac",
} as const;
const macbook: ClientInfo = {
  id: "macbook",
  name: "Maya's MacBook",
  kind: "personal",
  platform: "macos",
  personId: "maya",
  createdAt: "2026-10-26T12:00:00Z",
  lastSeenAt: "2026-10-28T11:59:30Z",
  connectedSince: null,
  current: true,
};
const tablet: ClientInfo = {
  id: "tablet",
  name: "Kitchen tablet",
  kind: "shared",
  platform: "web",
  personId: null,
  createdAt: "2026-10-28T11:50:00Z",
  lastSeenAt: null,
  connectedSince: null,
  current: false,
};

describe("a client's detail", () => {
  it.each([
    [null, "Never seen"],
    ["2026-10-28T11:59:00Z", "Seen just now"],
    ["2026-10-28T11:35:00Z", "Seen 25 minutes ago"],
    ["2026-10-28T10:30:00Z", "Seen an hour ago"],
    ["2026-10-28T03:00:00Z", "Seen 9 hours ago"],
  ])("says when it was last seen (%s)", (lastSeenAt, text) => {
    expect(seenText(lastSeenAt, now)).toBe(text);
  });

  it("names its person, or the household, its platform and when it was seen", () => {
    expect(clientDetail(tablet, undefined, now)).toBe(
      "Shared · Web browser · Never seen",
    );
    expect(clientDetail(macbook, maya, now)).toBe("Maya · macOS · This device");
  });
});

describe("Settings → Clients", () => {
  let root: Root;
  let container: HTMLDivElement;
  let approved: unknown[];

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    approved = [];
    vi.mocked(coreJson).mockReset();
    vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
      switch (path) {
        case "/api/auth/clients":
          return [macbook, tablet];
        case "/api/people":
          return [maya];
        case "/api/auth/pair/lookup":
          if ((init.json as { code: string }).code !== "K7QXM4PD") {
            throw new CoreError(404, "not_found");
          }
          return {
            code: "K7QXM4PD",
            platform: "web",
            suggestedName: "Lenovo Tab",
            address: "192.168.3.50",
            createdAt: "2026-10-28T11:58:00Z",
            expiresAt: "2026-10-28T12:08:00Z",
          };
        case "/api/auth/pair/approve":
          approved.push(init.json);
          return undefined;
        default:
          throw new Error(`Unexpected request: ${path}`);
      }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<ClientsSection />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  // Sets an input's value the way typing does, so React sees it.
  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function button(name: string) {
    return [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === name,
    )!;
  }

  async function editClient(name: string, action: string) {
    const trigger = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${name}: more"]`,
    )!;
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    const item = [
      ...document.querySelectorAll<HTMLElement>("[role=menuitem]"),
    ].find((candidate) => candidate.textContent === action)!;
    await act(async () => item.click());
  }

  it("lists every client, marking those never seen", () => {
    expect(container.textContent).toContain("Maya's MacBook");
    expect(container.textContent).toContain("Kitchen tablet");
    expect(container.textContent).toContain(
      "Shared · Web browser · Never seen",
    );
  });

  it("approves a shared device by its typed code and a name", async () => {
    await act(async () => button("Add a shared device").click());
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;

    await type(dialog.querySelector("input")!, "k7qx-m4pd");
    await act(async () => button("Find the device").click());
    expect(dialog.textContent).toContain("Approve K7QX-M4PD");
    expect(dialog.textContent).toContain("asked from 192.168.3.50");
    const name = dialog.querySelector<HTMLInputElement>("input")!;
    expect(name.value).toBe("Lenovo Tab");

    await type(name, "Kitchen tablet");
    await act(async () => button("Approve").click());

    expect(approved).toEqual([{ code: "K7QXM4PD", name: "Kitchen tablet" }]);
    expect(dialog.textContent).toContain("Kitchen tablet is approved");
  });

  it("says when no device shows a code", async () => {
    await act(async () => button("Add a shared device").click());
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;

    await type(dialog.querySelector("input")!, "W3RT-9HNC");
    await act(async () => button("Find the device").click());

    expect(dialog.querySelector("[role=alert]")!.textContent).toContain(
      "No device is showing this code",
    );
    expect(approved).toEqual([]);
  });

  it("checks a code's form before asking the host", async () => {
    await act(async () => button("Add a shared device").click());
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;

    await type(dialog.querySelector("input")!, "K7QX-M4P0");
    await act(async () => button("Find the device").click());

    expect(dialog.querySelector("[role=alert]")!.textContent).toContain(
      "8 letters and digits",
    );
    expect(coreJson).not.toHaveBeenCalledWith(
      "/api/auth/pair/lookup",
      expect.anything(),
    );
  });

  it("ignores a lookup from an approval dialog that was closed", async () => {
    const original = vi.mocked(coreJson).getMockImplementation()!;
    let finishLookup!: (value: unknown) => void;
    vi.mocked(coreJson).mockImplementation((path, init) =>
      path === "/api/auth/pair/lookup"
        ? new Promise((resolve) => {
            finishLookup = resolve;
          })
        : original(path, init),
    );
    await act(async () => button("Add a shared device").click());
    await type(document.querySelector("[role=dialog] input")!, "K7QX-M4PD");
    await act(async () => button("Find the device").click());
    await act(async () => button("Close").click());
    await act(async () => button("Add a shared device").click());

    await act(async () =>
      finishLookup({
        code: "K7QXM4PD",
        platform: "web",
        suggestedName: "Old device",
        address: "192.168.3.50",
      }),
    );

    const dialog = document.querySelector("[role=dialog]")!;
    expect(dialog.textContent).toContain("Find the device");
    expect(dialog.textContent).not.toContain("Old device");
    expect(dialog.textContent).not.toContain("Approve K7QX-M4PD");
  });

  it("keeps a newer edit open when an earlier rename finishes", async () => {
    const original = vi.mocked(coreJson).getMockImplementation()!;
    let finishRename!: (value: unknown) => void;
    vi.mocked(coreJson).mockImplementation((path, init) =>
      path === "/api/auth/clients/rename"
        ? new Promise((resolve) => {
            finishRename = resolve;
          })
        : original(path, init),
    );
    await editClient("Kitchen tablet", "Rename");
    await type(document.querySelector("[role=dialog] input")!, "Hall tablet");
    await act(async () => button("Save").click());
    await act(async () => button("Cancel").click());
    await editClient("Maya's MacBook", "Rename");
    await act(async () => finishRename(undefined));

    const input = document.querySelector<HTMLInputElement>(
      "[role=dialog] input",
    );
    expect(input?.value).toBe("Maya's MacBook");
  });

  it("ignores an approval response after choosing another code", async () => {
    const original = vi.mocked(coreJson).getMockImplementation()!;
    let finishApproval!: (value: unknown) => void;
    vi.mocked(coreJson).mockImplementation((path, init) =>
      path === "/api/auth/pair/approve"
        ? new Promise((resolve) => {
            finishApproval = resolve;
          })
        : original(path, init),
    );
    await act(async () => button("Add a shared device").click());
    await type(document.querySelector("[role=dialog] input")!, "K7QX-M4PD");
    await act(async () => button("Find the device").click());
    await act(async () => button("Approve").click());
    await act(async () => button("Another code").click());
    await act(async () => finishApproval(undefined));

    expect(document.querySelector("[role=dialog]")!.textContent).toContain(
      "Find the device",
    );
    expect(button("Find the device").disabled).toBe(false);
  });
});
