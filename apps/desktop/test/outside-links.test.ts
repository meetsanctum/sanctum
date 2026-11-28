import { describe, expect, it, vi } from "vitest";

import {
  createDocsWindowOpenHandler,
  isDocsUrl,
} from "../src/outside-links.js";

describe("links a page may open", () => {
  it("are Sanctum's docs, over HTTPS, and nothing else", () => {
    expect(
      isDocsUrl(
        "https://docs.meetsanctum.com/people/forgotten-password/#on-sanctum-itself",
      ),
    ).toBe(true);
    expect(isDocsUrl("http://docs.meetsanctum.com/")).toBe(false);
    expect(isDocsUrl("blob:https://docs.meetsanctum.com/guide")).toBe(false);
    expect(isDocsUrl("https://docs.meetsanctum.com.example/")).toBe(false);
    expect(isDocsUrl("https://example.com/?docs.meetsanctum.com")).toBe(false);
    expect(isDocsUrl("file:///etc/passwd")).toBe(false);
    expect(isDocsUrl("not a url")).toBe(false);
  });

  it("reports a failed browser launch and denies the popup", async () => {
    const open = vi.fn().mockRejectedValue(new Error("No browser"));
    const showError = vi.fn();
    const handle = createDocsWindowOpenHandler(open, showError);
    const url = "https://docs.meetsanctum.com/people/forgotten-password/";

    expect(handle({ url })).toEqual({ action: "deny" });
    expect(open).toHaveBeenCalledWith(url);
    await vi.waitFor(() => expect(showError).toHaveBeenCalledOnce());
  });
});
