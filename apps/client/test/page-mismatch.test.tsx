// @vitest-environment jsdom
import type { AppInfo } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageDoesntMatch, type PageMismatch } from "../src/page-mismatch";

// What takes the place of a page that can't open in its frame: which side
// is too old, and that what the app adds to the home keeps working.

const app = {
  id: "sanctum.weather",
  name: "Weather",
  version: "1.0.0",
} as AppInfo;

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

  const show = (mismatch: PageMismatch, isDevicePage?: boolean) =>
    act(async () =>
      root.render(
        <PageDoesntMatch
          app={app}
          mismatch={mismatch}
          isDevicePage={isDevicePage}
        />,
      ),
    );

  it.each([
    [
      "client",
      "To open this page, update this app",
      "It's too old for the pages of Weather 1.0.0.",
    ],
    [
      "sanctum",
      "This page needs a newer Sanctum",
      "Update Sanctum to open it.",
    ],
    [
      "pages",
      "This page needs an update of Weather",
      "It was made for an older Sanctum.",
    ],
  ] as const)("says which side is too old: %s", async (needs, title, line) => {
    await show({ needs });

    expect(host.querySelector("h1")?.textContent).toBe("Weather");
    expect(host.textContent).toContain(title);
    expect(host.textContent).toContain(line);
    expect(host.textContent).toContain(
      "What Weather adds to the home keeps working.",
    );
  });

  it("has no top bar of its own in a device's detail", async () => {
    await show({ needs: "pages" }, true);

    expect(host.querySelector("header")).toBeNull();
    expect(host.textContent).toContain("This page needs an update of Weather");
  });
});
