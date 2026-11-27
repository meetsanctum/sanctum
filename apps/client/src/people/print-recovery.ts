import type { HomeClock } from "@meetsanctum/app-sdk/clock";

import { productName } from "../brand";

// Printing a recovery code: one page with the person, their username, the
// code, when it was made and how to use it, printed from a frame of its own
// so nothing else on the screen comes with it. It says that anyone holding
// the page can choose a new password for them, and nothing on it is a
// password.

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

export function recoverySheet(input: {
  clock: HomeClock;
  person: string;
  username: string;
  code: string;
  madeAt: string;
}) {
  const made = input.clock.dayText(new Date(input.madeAt));
  const rows = [
    ["Person", input.person],
    ["Username", input.username],
    ["Made", made],
  ]
    .filter(([, value]) => value)
    .map(([term, value]) => `<dt>${term}</dt><dd>${escape(value!)}</dd>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Recovery code</title>
<style>
@page { margin: 20mm; }
body { margin: 0; font: 15px/21px Inter, system-ui, sans-serif; color: #222326; }
main { display: flex; flex-direction: column; gap: 24px; }
h1 { margin: 0; font-size: 28px; line-height: 34px; font-weight: 600; }
dl { margin: 0; display: grid; grid-template-columns: 120px 1fr; gap: 8px 16px; }
dt { color: #5c5e62; }
dd { margin: 0; }
.code { font-size: 40px; line-height: 48px; letter-spacing: 0.12em; font-weight: 500; font-variant-numeric: tabular-nums; }
h2 { margin: 0; font-size: 17px; line-height: 22px; font-weight: 600; }
ol { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; }
p { margin: 0; color: #45474b; }
</style></head>
<body><main>
<h1>${escape(productName)} recovery code</h1>
<dl>${rows}</dl>
<div class="code">${escape(input.code).split("-").join("-<wbr>")}</div>
<h2>If you forget your password</h2>
<ol>
<li>Open ${escape(productName)} on your Mac and choose your home.</li>
<li>Choose Just me, then Forgot your password?</li>
<li>Enter this code, then choose a new password.</li>
</ol>
<p>The code works once. Making a new code on your page in Settings → People ends this one. Restoring a backup also invalidates this code.</p>
<p>Keep this page with your important papers. Anyone with it can choose a new password for you.</p>
</main></body></html>`;
}

export function printRecoveryCode(input: Parameters<typeof recoverySheet>[0]) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText =
    "position:fixed;inset-inline-start:-10000px;width:0;height:0;border:0";
  document.body.append(frame);
  const page = frame.contentWindow;
  if (!page) {
    frame.remove();
    return;
  }
  page.document.open();
  page.document.write(recoverySheet(input));
  page.document.close();
  // The frame goes once the print dialog has closed.
  page.addEventListener("afterprint", () => frame.remove(), { once: true });
  page.focus();
  page.print();
}
