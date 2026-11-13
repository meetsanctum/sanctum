// The one email the waitlist sends: a short confirmation, as HTML for mail
// apps and as plain text for those that show only that. Mail apps keep
// little of CSS, so it is tables with their styles written on each cell.

export type WaitlistEmail = {
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
};

export function waitlistEmail(details: {
  productName: string;
  /** The site's address, without a slash at its end. */
  siteUrl: string;
  /** The White logo's address, as a picture mail apps can fetch. */
  logoUrl: string;
  repositoryUrl: string;
  xUrl: string;
  /** The page where this address leaves the waitlist. */
  unsubscribeUrl: string;
  /** Where a mail app's own Unsubscribe posts, to leave without the page. */
  oneClickUrl: string;
}): WaitlistEmail {
  const { productName, siteUrl, repositoryUrl, xUrl, unsubscribeUrl } = details;
  const site = siteUrl.replace(/^https?:\/\//, "");
  const subject = `You're on the ${productName} waitlist`;
  const thanks = `Thanks for joining the ${productName} waitlist. You'll get an email when there is news on the project, and nothing else.`;
  const meanwhile = `${productName} is free and open source, so you can look around in the meantime.`;
  const why = `You're getting this because this address joined the waitlist at ${site}.`;

  const text = [
    "You're on the list",
    "",
    thanks,
    "",
    meanwhile,
    `Source on GitHub: ${repositoryUrl}`,
    `Follow on X: ${xUrl}`,
    "",
    why,
    `Unsubscribe: ${unsubscribeUrl}`,
    "",
    siteUrl,
  ].join("\n");

  const font =
    "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
  const body = `font-family: ${font}; font-size: 17px; line-height: 27px; font-weight: 400; color: ${white};`;
  const small = `font-family: ${font}; font-size: 13px; line-height: 20px; font-weight: 400; color: ${silver};`;
  const link = `color: ${white}; font-weight: 500; text-decoration: underline;`;

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="supported-color-schemes" content="dark" />
    <title>${escape(subject)}</title>
  </head>
  <body style="margin: 0; padding: 0; background: ${carbon};">
    <div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">
      ${escape(`Thanks for joining. You'll hear when there is news on ${productName}.`)}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${carbon}" style="background: ${carbon};">
      <tr>
        <td align="center" style="padding: 48px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 480px;">
            <tr>
              <td style="padding-bottom: 40px;">
                <a href="${escape(siteUrl)}">
                  <img src="${escape(details.logoUrl)}" width="130" height="24" alt="${escape(productName.toLowerCase())}" style="display: block; border: 0;" />
                </a>
              </td>
            </tr>
            <tr>
              <td style="font-family: ${font}; font-size: 32px; line-height: 38px; font-weight: 300; letter-spacing: -0.02em; color: ${white}; padding-bottom: 20px;">
                You're on the list
              </td>
            </tr>
            <tr>
              <td style="${body} padding-bottom: 16px;">
                ${escape(thanks)}
              </td>
            </tr>
            <tr>
              <td style="${body} padding-bottom: 40px;">
                ${escape(meanwhile)}
                <a href="${escape(repositoryUrl)}" style="${link}">See the source on GitHub</a>
                or
                <a href="${escape(xUrl)}" style="${link}">follow on X</a>.
              </td>
            </tr>
            <tr>
              <td style="${small} padding-bottom: 12px;">
                ${escape(why)}
                <a href="${escape(unsubscribeUrl)}" style="color: ${silver}; text-decoration: underline;">Unsubscribe</a>
              </td>
            </tr>
            <tr>
              <td style="${small}">
                <a href="${escape(siteUrl)}" style="color: ${silver}; text-decoration: underline;">${escape(site)}</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;

  // What a mail app's own Unsubscribe uses: the address it posts to for
  // leaving in one click, which shows the page to whoever opens it instead.
  const headers = {
    "List-Unsubscribe": `<${details.oneClickUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };

  return { subject, html, text, headers };
}

// The brand's colours, as in the site's stylesheet.
const carbon = "#222326";
const white = "#ffffff";
const silver = "#c5c7ca";

const entities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escape(text: string) {
  return text.replace(/[&<>"']/g, (character) => entities[character] ?? "");
}
