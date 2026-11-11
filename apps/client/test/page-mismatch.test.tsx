// @vitest-environment jsdom
import type { AppInfo } from "@meetsanctum/app-sdk";
import moods from "@meetsanctum/moods/ui";
import type { CoreBridge } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hasPage, hostedApps, opens, pageOf } from "../src/apps";
import { PageDoesntMatch, pageMismatch } from "../src/page-mismatch";

// Pages that don't match the version the home runs: when they don't, that
// none of the app's UI is mounted, and what takes their place.

const provides = {
  entities: [],
  widgets: [],
  roomSections: [],
  devicePages: [],
};
const app = (over: Partial<AppInfo> = {}) =>
  ({
    id: moods.id,
    name: "Moods",
    version: moods.version,
    icon: null,
    pages: ["main", "room"],
    permissions: [],
    requests: [],
    state: "running",
    settings: null,
    provides,
    ...over,
  }) as AppInfo;
const bridge = {
  json: vi.fn(),
  live: {},
  ask: vi.fn(),
} as unknown as CoreBridge;

describe("whether a client's pages match", () => {
  it.each([
    // The home's version, the oldest page it takes, the client's pages' version,
    // the oldest app they take, and what's wrong.
    ["0.9.0", undefined, "0.9.0", undefined, undefined],
    ["0.10.0", undefined, "0.9.0", undefined, undefined],
    [
      "0.8.0",
      undefined,
      "0.9.0",
      undefined,
      { needs: "app", version: "0.9.0" },
    ],
    ["0.8.0", undefined, "0.9.0", "0.8.0", undefined],
    ["0.7.0", undefined, "0.9.0", "0.8.0", { needs: "app", version: "0.8.0" }],
    ["1.0.0", "1.0.0", "0.9.0", undefined, { needs: "client" }],
    ["1.0.0", "0.9.0", "0.9.0", undefined, undefined],
    ["1.0.0", "1.0.0", "1.0.0", undefined, undefined],
  ] as const)(
    "the home on %s (pages from %s), pages from %s (for %s)",
    (version, oldestPage, pages, oldestApp, wrong) => {
      expect(
        pageMismatch(
          { version, ...(oldestPage ? { oldestPage } : {}) },
          { version: pages, ...(oldestApp ? { oldestApp } : {}) },
        ),
      ).toEqual(wrong);
    },
  );

  it("takes an app whose file says nothing as working with any", () => {
    expect(pageMismatch({ version: "9.0.0" }, { version: "0.1.0" })).toBe(
      undefined,
    );
  });
});

describe("what the shell hosts", () => {
  it("has the whole of its UI when they match", () => {
    const [hosted] = hostedApps([app()], bridge);

    expect(hosted?.mismatch).toBeUndefined();
    expect(hosted?.ui.Provider).toBeDefined();
    expect(pageOf(hosted, "main")).toBeDefined();
    expect(opens(hosted!)).toBe(true);
  });

  it("mounts none of it when they don't, though its pages can still be opened", () => {
    const [hosted] = hostedApps([app({ version: "0.0.1" })], bridge);

    expect(hosted?.mismatch).toEqual({ needs: "app", version: moods.version });
    expect(hosted?.ui.Provider).toBeUndefined();
    expect(hosted?.ui.devicePages).toBeUndefined();
    expect(pageOf(hosted, "main")).toBeUndefined();
    expect(hasPage(hosted, "main")).toBe(true);
    expect(opens(hosted!)).toBe(true);
  });

  it("offers none the home doesn't list, even so", () => {
    const [hosted] = hostedApps([app({ version: "0.0.1" })], bridge);

    expect(hasPage(hosted, "nothing")).toBe(false);
  });

  it("mounts none of it for pages too old for the home", () => {
    const [hosted] = hostedApps(
      [app({ version: "99.0.0", oldestPage: "99.0.0" })],
      bridge,
    );

    expect(hosted?.mismatch).toEqual({ needs: "client" });
    expect(hosted?.ui.Provider).toBeUndefined();
  });
});

describe("what takes a page's place", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("says which version the page needs, and which it's on", async () => {
    await act(async () =>
      root.render(
        <PageDoesntMatch
          app={app({ name: "Weather", version: "0.3.0" })}
          mismatch={{ needs: "app", version: "0.4.0" }}
        />,
      ),
    );

    expect(host.textContent).toContain(
      "This page needs Weather 0.4.0 or later",
    );
    expect(host.textContent).toContain("It's on 0.3.0.");
  });

  it("says to update this app when its pages are too old", async () => {
    await act(async () =>
      root.render(
        <PageDoesntMatch
          app={app({ name: "Weather", version: "1.0.0" })}
          mismatch={{ needs: "client" }}
        />,
      ),
    );

    expect(host.textContent).toContain("To open this page, update this app");
    expect(host.textContent).toContain("too old for Weather 1.0.0");
  });
});
