import { describe, expect, it } from "vitest";

import { isDocsUrl } from "../src/outside-links.js";

describe("links a page may open", () => {
  it("are Sanctum's docs, over HTTPS, and nothing else", () => {
    expect(
      isDocsUrl(
        "https://docs.meetsanctum.com/people/forgotten-password/#on-sanctum-itself",
      ),
    ).toBe(true);
    expect(isDocsUrl("http://docs.meetsanctum.com/")).toBe(false);
    expect(isDocsUrl("https://docs.meetsanctum.com.example/")).toBe(false);
    expect(isDocsUrl("https://example.com/?docs.meetsanctum.com")).toBe(false);
    expect(isDocsUrl("file:///etc/passwd")).toBe(false);
    expect(isDocsUrl("not a url")).toBe(false);
  });
});
