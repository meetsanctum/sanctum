import { chmod, mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answer, createPageStore, keptAs } from "../src/page-store.js";

// The desktop app's store of apps' page files and the kit: kept as the core
// served them, by host and by the build's digest, never the entry.

const ticket = `page_${"A".repeat(43)}`;
const origin = "https://192.168.1.20:4100";
const page = `${origin}/pages/${ticket}/apps/sanctum.weather/0123456789abcdef/`;
const kit = `${origin}/pages/${ticket}/kit/9edd26f3b3eae8d8/`;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sanctum-page-store-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const served = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      "set-cookie": "never=kept",
    },
  });

describe("what the store keeps", () => {
  it("is a page's files and the kit's, by build and file", () => {
    expect(keptAs(`${page}index.js`)).toEqual({
      build: "apps/sanctum.weather/0123456789abcdef",
      file: "index.js",
    });
    expect(keptAs(`${page}chunks/day-1a2b.js`)?.file).toBe(
      "chunks/day-1a2b.js",
    );
    expect(keptAs(`${kit}icons/check.js`)).toEqual({
      build: "kit/9edd26f3b3eae8d8",
      file: "icons/check.js",
    });
    expect(keptAs(`${page}-chunks/-day.js`)?.file).toBe("-chunks/-day.js");
  });

  it.each([
    ["the entry", page],
    ["the entry by name", `${page}index.html`],
    ["a query", `${page}index.js?x=1`],
    ["the API", `${origin}/api/apps`],
    [
      "a climb out",
      `${page}../../../kit/9edd26f3b3eae8d8/react.js`.replace(
        "/../../../",
        "/%2e%2e/",
      ),
    ],
    ["a hidden name", `${page}.env`],
  ])("isn't %s", (_what, url) => {
    expect(keptAs(url)).toBeUndefined();
  });
});

describe("the store", () => {
  it("keeps case-sensitive file and folder names distinct on disk", async () => {
    const store = createPageStore(root);
    const files = ["Icon.svg", "icon.svg", "A/icon.svg", "a/icon.svg"];
    for (const file of files) {
      await store.put("host-1", `${page}${file}`, served(file));
    }
    for (const file of files) {
      expect(await (await store.get("host-1", `${page}${file}`))!.text()).toBe(
        file,
      );
    }
  });

  it("gives back a file as the core served it, with its headers but no cookie", async () => {
    const store = createPageStore(root);
    await store.put("host-1", `${page}index.js`, served("export default 1;"));
    const kept = await store.get("host-1", `${page}index.js`);
    expect(await kept!.text()).toBe("export default 1;");
    expect(kept!.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(kept!.headers.get("access-control-allow-origin")).toBe("*");
    expect(kept!.headers.get("set-cookie")).toBeNull();
    // Another host's files are its own.
    expect(await store.get("host-2", `${page}index.js`)).toBeUndefined();
  });

  it("keeps no answer but a 200, and nothing for a host it can't name", async () => {
    const store = createPageStore(root);
    await store.put("host-1", `${page}index.js`, served("gone", 404));
    await store.put("../host", `${page}index.js`, served("x"));
    expect(await store.get("host-1", `${page}index.js`)).toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });

  it("takes away builds no page has used for a month", async () => {
    const at = Date.parse("2026-11-17T00:00:00Z");
    const store = createPageStore(root, () => at);
    await store.put("host-1", `${page}index.js`, served("old"));
    await store.put("host-1", `${kit}react.js`, served("kit"));
    const old = join(root, "host-1/apps/sanctum.weather/0123456789abcdef");
    const month = new Date(at - 31 * 24 * 60 * 60_000);
    await utimes(old, month, month);
    await store.prune();
    expect(await stat(old).catch(() => null)).toBeNull();
    expect(await store.get("host-1", `${kit}react.js`)).toBeDefined();
  });

  it("retains a build used during a long session when the app starts again", async () => {
    let at = Date.parse("2026-11-17T00:00:00Z");
    const store = createPageStore(root, () => at);
    await store.put("host-1", `${page}index.js`, served("page"));
    await store.put("host-1", `${kit}react.js`, served("kit"));
    at += 31 * 24 * 60 * 60_000;
    expect(await store.get("host-1", `${page}index.js`)).toBeDefined();

    const restarted = createPageStore(root, () => at);
    await restarted.prune();
    expect(
      await (await restarted.get("host-1", `${page}index.js`))!.text(),
    ).toBe("page");
    expect(await restarted.get("host-1", `${kit}react.js`)).toBeUndefined();
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "continues cleanup when a build cannot be removed",
    async () => {
      const store = createPageStore(root);
      await store.put("host-1", `${kit}react.js`, served("kit"));
      await store.put("host-1", `${page}index.js`, served("page"));
      const kitFolder = join(root, "host-1/kit");
      const appBuild = join(
        root,
        "host-1/apps/sanctum.weather/0123456789abcdef",
      );
      await utimes(
        join(kitFolder, "9edd26f3b3eae8d8"),
        new Date(0),
        new Date(0),
      );
      await utimes(appBuild, new Date(0), new Date(0));
      await chmod(kitFolder, 0o500);
      try {
        await expect(store.prune()).resolves.toBeUndefined();
        expect(await stat(appBuild).catch(() => null)).toBeNull();
        expect(await store.get("host-1", `${kit}react.js`)).toBeDefined();
      } finally {
        await chmod(kitFolder, 0o700);
      }
    },
  );
});

describe("a request of the page's session", () => {
  const request = (url: string, method = "GET") => new Request(url, { method });

  it("gets a page's file from the core once, and from the store after", async () => {
    const store = createPageStore(root);
    const passOn = vi.fn(async () => served("export default 1;"));
    const options = { store, host: () => "host-1", passOn };
    const first = await answer(request(`${page}index.js`), options);
    expect(await first.text()).toBe("export default 1;");
    const again = await answer(request(`${page}index.js`), options);
    expect(await again.text()).toBe("export default 1;");
    expect(again.headers.get("access-control-allow-origin")).toBe("*");
    expect(passOn).toHaveBeenCalledOnce();
  });

  it("passes on everything else as it was", async () => {
    const store = createPageStore(root);
    const passOn = vi.fn(async () => new Response("passed"));
    const options = { store, host: () => "host-1", passOn };
    for (const each of [
      request(page),
      request(`${origin}/api/apps`),
      request(`${page}index.js`, "POST"),
    ]) {
      expect(await (await answer(each, options)).text()).toBe("passed");
    }
    expect(passOn).toHaveBeenCalledTimes(3);
    expect(await readdir(root)).toEqual([]);
  });

  it("keeps nothing while a first contact is checked, or from a refusal", async () => {
    const store = createPageStore(root);
    const passOn = vi.fn(async () => served("x"));
    await answer(request(`${page}index.js`), {
      store,
      host: () => null,
      passOn,
    });
    await answer(request(`${kit}react.js`), {
      store,
      host: () => "host-1",
      passOn: async () => served("nope", 404),
    });
    expect(await readdir(root)).toEqual([]);
  });
});
