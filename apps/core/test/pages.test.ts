import { defineApp } from "@meetsanctum/app-sdk";
import type { PageTicket } from "@meetsanctum/auth-protocol";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { digestOf } from "../src/pages/files.js";
import { kitFits } from "../src/pages/pages.js";
import { ticketGraceMs, ticketWeekMs } from "../src/pages/tickets.js";
import {
  claimed,
  get,
  post,
  sharedClient,
  testCore,
  type TestCore,
} from "./support.js";

// Apps' pages and the kit, as a frame loads them: under the client's page
// ticket, by lookup in what the core indexed, with a policy that lets a page
// load its own files and the kit's and nothing else.

const example = {
  origin: "official" as const,
  app: defineApp({
    id: "sanctum.example",
    name: "Example",
    version: "1.0.0",
    core: "^1.0.0",
    permissions: [],
    actions: [],
    events: [],
  }),
};

let core: TestCore;
let kitDir: string;
let token: string;

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

async function writeAll(root: string, files: Record<string, string>) {
  for (const [name, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), body);
  }
}

const kitFiles = {
  "react.js": "export const useState = 1;",
  "ui-sdk.js": "export const PageBar = 1;",
  "kit.css": ":root{--carbon:#222326}",
  "icons/check.js": "export default 1;",
  "assets/inter.woff2": "font",
};
const kitDigest = digestOf(
  Object.entries(kitFiles).map(([name, body]) => [
    name,
    { sha256: sha256(body) },
  ]),
);

const pageFiles = {
  "index.js": `import { PageBar } from "@meetsanctum/ui-sdk"; export default PageBar;`,
  "pages.css": ".text-orange{color:var(--ember-text)}",
};
const pageDigest = digestOf(
  Object.entries(pageFiles).map(([name, body]) => [
    name,
    { sha256: sha256(body) },
  ]),
);

// Example's pages, built into its staged package as `sanctum-pages build` does.
async function stagePages(
  files: Record<string, string> = pageFiles,
  listed: Record<string, { size: number; sha256: string }> = Object.fromEntries(
    Object.entries(pageFiles).map(([name, body]) => [
      name,
      { size: Buffer.byteLength(body), sha256: sha256(body) },
    ]),
  ),
  builtFor = "0.1.0",
) {
  const pagesDir = join(
    core.dataDir,
    "no-packages/sanctum.example/1.0.0+test/pages",
  );
  await writeAll(pagesDir, {
    ...files,
    "pages.json": JSON.stringify({
      kit: builtFor,
      digest: pageDigest,
      entry: "index.js",
      stylesheet: "pages.css",
      files: Object.fromEntries(
        Object.entries(listed).map(([name, file]) => [
          name,
          { type: "text/javascript; charset=utf-8", ...file },
        ]),
      ),
    }),
  });
  return pagesDir;
}

async function ticketFor(clientToken = token) {
  const response = await post(
    core,
    "/api/pages/ticket",
    {},
    { token: clientToken },
  );
  expect(response.statusCode).toBe(200);
  return response.json<PageTicket>();
}

beforeEach(async () => {
  kitDir = await mkdtemp(join(tmpdir(), "sanctum-kit-"));
  await writeAll(kitDir, {
    ...kitFiles,
    // Not a type a page may load, so it isn't served.
    "notes.txt": "not served",
    "kit.json": JSON.stringify({
      version: "0.1.0",
      bridge: 1,
      digest: kitDigest,
      stylesheet: "kit.css",
      imports: {
        react: "react.js",
        "@meetsanctum/ui-sdk": "ui-sdk.js",
        "@meetsanctum/ui-sdk/icons/": "icons/",
      },
    }),
  });
  core = await testCore({ apps: [example], kitDir });
  token = (await claimed(core)).token;
});

afterEach(async () => {
  await core.stop();
  await rm(kitDir, { recursive: true, force: true });
});

describe("a page ticket", () => {
  it("is given to a signed-in client, with when it runs out and the home's kit", async () => {
    const { ticket, expiresAt, kit } = await ticketFor();
    expect(ticket).toMatch(/^page_[A-Za-z0-9_-]{43}$/);
    expect(new Date(expiresAt).getTime()).toBe(
      core.now().getTime() + ticketWeekMs + ticketGraceMs,
    );
    expect(kit).toEqual({ version: "0.1.0", bridge: 1, digest: kitDigest });
  });

  it("is given to a shared client too, and to nobody without a client", async () => {
    const shared = sharedClient(core);
    expect((await ticketFor(shared.token)).ticket).toMatch(/^page_/);
    expect((await post(core, "/api/pages/ticket", {})).statusCode).toBe(401);
  });

  it("isn't a client token", async () => {
    const { ticket } = await ticketFor();
    expect((await get(core, "/api/apps", { token: ticket })).statusCode).toBe(
      401,
    );
  });

  it("says there's no kit where the core's image has none", async () => {
    await rm(kitDir, { recursive: true, force: true });
    const fresh = await testCore({ apps: [example], kitDir });
    try {
      const signedIn = await claimed(fresh);
      const response = await post(
        fresh,
        "/api/pages/ticket",
        {},
        {
          token: signedIn.token,
        },
      );
      expect(response.json<PageTicket>().kit).toBeNull();
    } finally {
      await fresh.stop();
    }
  });
});

describe("the kit", () => {
  it("is served under a ticket, file by file, with its type and the frame's policy", async () => {
    const { ticket } = await ticketFor();
    const response = await get(
      core,
      `/pages/${ticket}/kit/${kitDigest}/react.js`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(kitFiles["react.js"]);
    expect(response.headers["content-type"]).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toContain(
      "sandbox allow-scripts",
    );
    const font = await get(
      core,
      `/pages/${ticket}/kit/${kitDigest}/assets/inter.woff2`,
    );
    expect(font.headers["content-type"]).toBe("font/woff2");
  });

  it("is nothing at another digest, for a file it doesn't have or one of a type no page loads", async () => {
    const { ticket } = await ticketFor();
    for (const url of [
      `/pages/${ticket}/kit/0123456789abcdef/react.js`,
      `/pages/${ticket}/kit/${kitDigest}/missing.js`,
      `/pages/${ticket}/kit/${kitDigest}/notes.txt`,
      `/pages/${ticket}/kit/${kitDigest}/kit.json`,
      `/pages/${ticket}/kit/${kitDigest}/%2e%2e%2fkit.json`,
      `/pages/${ticket}/kit/${kitDigest}/icons/..%2f..%2fkit.json`,
    ]) {
      const response = await get(core, url);
      expect(response.statusCode, url).toBe(404);
    }
    // An address that climbs out with dots is resolved before it's routed,
    // as a browser resolves it, so it reaches no page at all.
    const climbing = await get(
      core,
      `/pages/${ticket}/kit/${kitDigest}/../kit.json`,
    );
    expect(climbing.statusCode).not.toBe(200);
    expect(climbing.body).not.toContain("imports");
  });
});

describe("a ticket that opens nothing", () => {
  it("gets the same answer as a file that isn't there, so nobody learns what a home has", async () => {
    const { ticket } = await ticketFor();
    await stagePages();
    const made = `page_${"A".repeat(43)}`;
    const missing = await get(
      core,
      `/pages/${ticket}/kit/${kitDigest}/missing.js`,
    );
    for (const url of [
      `/pages/${made}/kit/${kitDigest}/react.js`,
      `/pages/${made}/apps/sanctum.example/${pageDigest}/`,
      `/pages/not-a-ticket/kit/${kitDigest}/react.js`,
    ]) {
      const response = await get(core, url);
      expect(response.statusCode, url).toBe(404);
      expect(response.body).toBe(missing.body);
    }
  });

  it("is one that's run out, a day past its week", async () => {
    const { ticket } = await ticketFor();
    const url = `/pages/${ticket}/kit/${kitDigest}/react.js`;
    core.advance(ticketWeekMs + ticketGraceMs - 1);
    expect((await get(core, url)).statusCode).toBe(200);
    core.advance(1);
    expect((await get(core, url)).statusCode).toBe(404);
  });

  it("is one whose client was removed", async () => {
    const shared = sharedClient(core);
    const { ticket } = await ticketFor(shared.token);
    const url = `/pages/${ticket}/kit/${kitDigest}/react.js`;
    expect((await get(core, url)).statusCode).toBe(200);
    const revoked = await post(
      core,
      "/api/auth/clients/revoke",
      { id: shared.id },
      { token },
    );
    expect(revoked.statusCode).toBe(204);
    expect((await get(core, url)).statusCode).toBe(404);
  });

  it("turns its address away once it sends too many", async () => {
    const made = `page_${"B".repeat(43)}`;
    const url = `/pages/${made}/kit/${kitDigest}/react.js`;
    for (let each = 0; each < 30; each++) {
      expect(
        (await get(core, url, { remoteAddress: "192.0.2.7" })).statusCode,
      ).toBe(404);
    }
    const { ticket } = await ticketFor();
    const good = `/pages/${ticket}/kit/${kitDigest}/react.js`;
    expect(
      (await get(core, good, { remoteAddress: "192.0.2.7" })).statusCode,
    ).toBe(429);
    expect(
      (await get(core, good, { remoteAddress: "192.0.2.8" })).statusCode,
    ).toBe(200);
    // Once the window has passed, it's let in again.
    core.advance(5 * 60_000);
    expect(
      (await get(core, good, { remoteAddress: "192.0.2.7" })).statusCode,
    ).toBe(200);
  });

  it("is a client's oldest once it has asked for four after it", async () => {
    const tickets = [];
    for (let each = 0; each < 5; each++) {
      tickets.push((await ticketFor()).ticket);
      core.advance(1);
    }
    const opens = async (ticket: string) =>
      (await get(core, `/pages/${ticket}/kit/${kitDigest}/react.js`))
        .statusCode === 200;
    expect(await opens(tickets[0]!)).toBe(false);
    for (const ticket of tickets.slice(1))
      expect(await opens(ticket)).toBe(true);
  });
});

describe("an app's pages", () => {
  it("open at their entry, which the core writes with the kit's import map under the ticket", async () => {
    const { ticket } = await ticketFor();
    await stagePages();
    const response = await get(
      core,
      `/pages/${ticket}/apps/sanctum.example/${pageDigest}/`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");

    const kitPath = `/pages/${ticket}/kit/${kitDigest}/`;
    const pagePath = `/pages/${ticket}/apps/sanctum.example/${pageDigest}/`;
    const importMap = /<script type="importmap">(.*?)<\/script>/.exec(
      response.body,
    )![1]!;
    expect(JSON.parse(importMap)).toEqual({
      imports: {
        react: `${kitPath}react.js`,
        "@meetsanctum/ui-sdk": `${kitPath}ui-sdk.js`,
        "@meetsanctum/ui-sdk/icons/": `${kitPath}icons/`,
      },
    });
    expect(response.body).toContain("<title>Example</title>");
    expect(response.body).toContain(
      `<link rel="stylesheet" href="${kitPath}kit.css">`,
    );
    expect(response.body).toContain(
      `<link rel="stylesheet" href="${pagePath}pages.css">`,
    );
    expect(response.body).toContain(
      `<script type="module" src="${pagePath}index.js"></script>`,
    );

    // The policy allows the import map by its hash, and loads from the
    // page's folder and the kit's by their exact addresses.
    const origin = "http://localhost:80";
    const policy = response.headers["content-security-policy"] as string;
    const hash = createHash("sha256").update(importMap).digest("base64");
    expect(policy.split("; ")).toEqual([
      "default-src 'none'",
      `script-src ${origin}${pagePath} ${origin}${kitPath} 'sha256-${hash}'`,
      `style-src ${origin}${pagePath} ${origin}${kitPath}`,
      `font-src ${origin}${kitPath}`,
      `img-src ${origin}${pagePath} ${origin}${kitPath} data: blob:`,
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "sandbox allow-scripts",
      "frame-ancestors app://sanctum",
    ]);
    expect(
      (
        await get(
          core,
          `/pages/${ticket}/apps/sanctum.example/${pageDigest}/index.html`,
        )
      ).body,
    ).toBe(response.body);
  });

  it("serve each file they list, as it is", async () => {
    const { ticket } = await ticketFor();
    await stagePages();
    const base = `/pages/${ticket}/apps/sanctum.example/${pageDigest}`;
    const code = await get(core, `${base}/index.js`);
    expect(code.body).toBe(pageFiles["index.js"]);
    expect(code.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    const css = await get(core, `${base}/pages.css`);
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect((await get(core, `${base}/pages.json`)).statusCode).toBe(404);
  });

  it("are nothing at another digest, for an app that isn't installed, or a file they don't list", async () => {
    const { ticket } = await ticketFor();
    const pagesDir = await stagePages();
    await writeFile(join(pagesDir, "extra.js"), "export default 2;");
    for (const url of [
      `/pages/${ticket}/apps/sanctum.example/0123456789abcdef/`,
      `/pages/${ticket}/apps/sanctum.missing/${pageDigest}/`,
      `/pages/${ticket}/apps/sanctum.example/${pageDigest}/extra.js`,
      `/pages/${ticket}/apps/sanctum.example/${pageDigest}/..%2fsanctum-app.json`,
    ]) {
      expect((await get(core, url)).statusCode, url).toBe(404);
    }
    // Without its last slash it's no page's address, and nothing redirects.
    const bare = await get(
      core,
      `/pages/${ticket}/apps/sanctum.example/${pageDigest}`,
    );
    expect(bare.statusCode).not.toBe(200);
    expect(bare.headers.location).toBeUndefined();
  });

  it("aren't served at all when a file isn't what pages.json says", async () => {
    const { ticket } = await ticketFor();
    await stagePages({ ...pageFiles, "index.js": "export default 'changed';" });
    expect(
      (await get(core, `/pages/${ticket}/apps/sanctum.example/${pageDigest}/`))
        .statusCode,
    ).toBe(404);
    expect(
      core.logs.some((line) => line.includes("isn't what its pages.json says")),
    ).toBe(true);
  });

  it.each([
    ["a null manifest", null],
    [
      "null file metadata",
      { kit: "0.1.0", entry: "index.js", files: { "index.js": null } },
    ],
  ])(
    "aren't served when pages.json holds %s",
    async (_description, manifest) => {
      const { ticket } = await ticketFor();
      const pagesDir = await stagePages();
      await writeFile(join(pagesDir, "pages.json"), JSON.stringify(manifest));
      const response = await get(
        core,
        `/pages/${ticket}/apps/sanctum.example/${pageDigest}/`,
      );
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "not_found" });
    },
  );

  it("aren't served when pages/ itself links outside the staged package", async () => {
    const { ticket } = await ticketFor();
    const pagesDir = await stagePages();
    const outside = join(kitDir, "outside-pages");
    await rename(pagesDir, outside);
    await symlink(outside, pagesDir);
    expect(
      (await get(core, `/pages/${ticket}/apps/sanctum.example/${pageDigest}/`))
        .statusCode,
    ).toBe(404);
  });

  it("aren't served when pages.json names a file outside pages/ or a link out of it", async () => {
    const { ticket } = await ticketFor();
    const outside = await stagePages(pageFiles, {
      "../sanctum-app.json": { size: 1, sha256: "0".repeat(64) },
    });
    expect(
      (await get(core, `/pages/${ticket}/apps/sanctum.example/${pageDigest}/`))
        .statusCode,
    ).toBe(404);
    await rm(outside, { recursive: true, force: true });
    await core.stop();

    // A fresh core, so nothing is kept from the index before.
    core = await testCore({ apps: [example], kitDir, dataDir: core.dataDir });
    const again = await ticketFor(
      (await claimed(core).catch(() => null))?.token ?? token,
    );
    const pagesDir = await stagePages();
    await rm(join(pagesDir, "pages.css"));
    await symlink(join(kitDir, "kit.css"), join(pagesDir, "pages.css"));
    expect(
      (
        await get(
          core,
          `/pages/${again.ticket}/apps/sanctum.example/${pageDigest}/`,
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe("pages built for a kit", () => {
  it("fit any kit of its major from that version on, where below 1.0 the minor is the major", () => {
    expect(kitFits("0.1.0", "0.1.0")).toBe(true);
    expect(kitFits("0.1.0", "0.1.3")).toBe(true);
    expect(kitFits("0.1.3", "0.1.0")).toBe(false);
    expect(kitFits("0.1.0", "0.2.0")).toBe(false);
    expect(kitFits("1.2.0", "1.4.0")).toBe(true);
    expect(kitFits("1.4.1", "1.4.0")).toBe(false);
    expect(kitFits("1.2.0", "2.0.0")).toBe(false);
    expect(kitFits("not a version", "1.0.0")).toBe(false);
  });

  it("aren't served by a core whose kit can't stand in for theirs, which it says once", async () => {
    const { ticket } = await ticketFor();
    await stagePages(undefined, undefined, "0.2.0");
    const url = `/pages/${ticket}/apps/sanctum.example/${pageDigest}/`;
    expect((await get(core, url)).statusCode).toBe(404);
    expect((await get(core, url)).statusCode).toBe(404);
    expect(
      core.logs.filter((line) => line.includes("need kit 0.2.0")),
    ).toHaveLength(1);
  });
});

describe("a kit that couldn't be read", () => {
  it("is tried again next time, rather than kept failed", async () => {
    await rm(kitDir, { recursive: true, force: true });
    await writeAll(kitDir, kitFiles);
    await writeFile(
      join(kitDir, "kit.json"),
      JSON.stringify({
        version: "0.1.0",
        bridge: 1,
        digest: kitDigest,
        stylesheet: "kit.css",
        imports: { react: "react.js" },
      }),
    );
    await chmod(join(kitDir, "icons"), 0o000);
    const fresh = await testCore({ apps: [example], kitDir });
    try {
      const signedIn = await claimed(fresh);
      const ask = () =>
        post(fresh, "/api/pages/ticket", {}, { token: signedIn.token });
      const first = await ask();
      expect(first.statusCode).toBe(200);
      expect(first.json<PageTicket>().kit).toBeNull();
      await chmod(join(kitDir, "icons"), 0o755);
      expect((await ask()).json<PageTicket>().kit?.digest).toBe(kitDigest);
    } finally {
      await chmod(join(kitDir, "icons"), 0o755).catch(() => undefined);
      await fresh.stop();
    }
  });
});
