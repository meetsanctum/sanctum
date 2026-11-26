// @vitest-environment jsdom
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, onTestFinished, vi } from "vitest";

it("honors drawing overrides in the display build", async () => {
  const out = await mkdtemp(join(tmpdir(), "sanctum-display-build-"));
  onTestFinished(() => rm(out, { recursive: true, force: true }));
  await promisify(execFile)("pnpm", ["run", "build:display", "--outDir", out], {
    // Vite also uses NODE_ENV to decide whether to enable development behavior.
    env: { ...process.env, NODE_ENV: "production" },
    timeout: 90_000,
  });

  const html = await readFile(join(out, "index.html"), "utf8");
  const page = new DOMParser().parseFromString(html, "text/html");
  const entry = page.querySelector<HTMLScriptElement>('script[type="module"]');
  const base = "/__display/built/";
  const src = entry?.getAttribute("src") ?? "";
  expect(src.startsWith(base)).toBe(true);
  document.body.innerHTML = page.body.innerHTML;
  history.replaceState(null, "", "?effects=reduced&motion=reduced");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
  );
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });

  createRequire(join(out, "index.html"))(join(out, src.slice(base.length)));

  expect(document.documentElement.dataset.effects).toBe("reduced");
  expect(document.documentElement.dataset.motion).toBe("reduced");
}, 120_000);
