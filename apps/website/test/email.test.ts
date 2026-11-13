import { describe, expect, it } from "vitest";

import { waitlistEmail } from "../src/waitlist/email";

// The waitlist's confirmation, as HTML and as plain text.

const details = {
  productName: "Example",
  siteUrl: "https://example.com",
  logoUrl: "https://example.com/logo.png",
  repositoryUrl: "https://example.com/source",
  xUrl: "https://example.com/x",
  unsubscribeUrl: "https://example.com/unsubscribe/contact-1",
  oneClickUrl: "https://example.com/api/unsubscribe/contact-1",
};

describe("the waitlist's confirmation", () => {
  it("says the same in HTML and in plain text", () => {
    const email = waitlistEmail(details);
    expect(email.subject).toBe("You're on the Example waitlist");
    for (const body of [email.html, email.text]) {
      expect(body).toContain("You're on the list");
      expect(body).toContain("Thanks for joining the Example waitlist.");
      expect(body).toContain("https://example.com/source");
      expect(body).toContain("https://example.com/x");
      expect(body).toContain("joined the waitlist at example.com");
      expect(body).toContain("https://example.com/unsubscribe/contact-1");
    }
    expect(email.html).toContain('src="https://example.com/logo.png"');
  });

  it("gives mail apps a way off the list in one click", () => {
    expect(waitlistEmail(details).headers).toEqual({
      "List-Unsubscribe": "<https://example.com/api/unsubscribe/contact-1>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("writes what it is given as text, never as markup", () => {
    const email = waitlistEmail({
      ...details,
      productName: `<b>"Home" & more</b>`,
    });
    expect(email.html).not.toContain("<b>");
    expect(email.html).toContain("&lt;b&gt;&quot;Home&quot; &amp; more");
    expect(email.text).toContain(`<b>"Home" & more</b>`);
  });
});
