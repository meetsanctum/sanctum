import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  clientFile,
  contentSecurityPolicy,
  isClientUrl,
  serveClient,
} from "../src/client-files.js";

const root = "/app/client/dist";

describe("the client's files", () => {
  it("are served from the app's own origin", () => {
    expect(isClientUrl("app://sanctum/")).toBe(true);
    expect(isClientUrl("app://other/")).toBe(false);
    expect(isClientUrl("http://sanctum/")).toBe(false);
    expect(isClientUrl("not a url")).toBe(false);
  });

  it("map to files under the client's build, with the page for app paths", () => {
    expect(clientFile(root, "app://sanctum/assets/index.js")).toBe(
      "/app/client/dist/assets/index.js",
    );
    expect(clientFile(root, "app://sanctum/")).toBe(
      "/app/client/dist/index.html",
    );
    expect(clientFile(root, "app://sanctum/settings/people")).toBe(
      "/app/client/dist/index.html",
    );
  });

  it("never reach outside the build", () => {
    for (const url of [
      "app://sanctum/../../etc/passwd",
      "app://sanctum/%2e%2e/%2e%2e/etc/passwd",
      "app://sanctum/assets/..%2f..%2f..%2fetc%2fpasswd",
    ]) {
      const file = clientFile(root, url);
      expect(file === undefined || file.startsWith(`${root}/`)).toBe(true);
    }
    expect(clientFile(root, "app://elsewhere/index.html")).toBeUndefined();
  });

  it("give the page its content security policy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sanctum-client-"));
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "index.html"), "<!doctype html>");
    await writeFile(join(dir, "assets", "index.js"), "export {};");

    const packaged = { allowPlainHttp: false };
    const page = await serveClient(dir, "app://sanctum/", packaged);
    const script = await serveClient(
      dir,
      "app://sanctum/assets/index.js",
      packaged,
    );
    const missing = await serveClient(
      dir,
      "app://sanctum/assets/gone.js",
      packaged,
    );

    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toBe(
      contentSecurityPolicy(false),
    );
    // A packaged app reaches hosts over HTTPS and WSS only.
    expect(contentSecurityPolicy(false)).toContain("connect-src https: wss:;");
    // The fonts ship with the page: no public host is allowed.
    expect(contentSecurityPolicy(false)).toContain("font-src 'self';");
    expect(contentSecurityPolicy(false)).not.toMatch(/google|gstatic/);
    expect(contentSecurityPolicy(true)).toContain(
      "connect-src https: wss: http: ws:;",
    );
    expect(script.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(missing.status).toBe(404);
  });
});
