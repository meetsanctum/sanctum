import { defineAction, defineApp } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createNet, createRequestsUnderWay } from "../src/app-host/net.js";
import { claimed, post, testCore } from "./support.js";

// ctx.net.fetch(): an app reaches the internet only at the hosts it holds
// net:<host> for, over HTTPS, on public addresses (public-internet.test.ts
// covers names), without following redirects, for at most 10 s and 1 MB, and
// only while it holds that: a request under way ends with the permission or
// with the app.

const fetchAction = defineAction({
  id: "web.get",
  title: "Fetch",
  tier: "read",
  input: z.object({ url: z.string(), timeoutMs: z.number().optional() }),
  output: z.unknown(),
  async run(ctx, input) {
    return ctx.net.fetch(input);
  },
});

const web = defineApp({
  id: "test.web",
  name: "Web",
  version: "0.1.0",
  core: "^1.0.0",
  permissions: [
    { id: "net:api.example.com", reason: "For the test." },
    { id: "places.read", reason: "For the test.", needed: true },
  ],
  actions: [fetchAction],
  events: [],
});

async function webCore(
  answer: (init?: RequestInit) => Response | Promise<Response>,
) {
  const internet = vi.fn(
    async (_input: string | URL | Request, init?: RequestInit) => answer(init),
  );
  const core = await testCore({
    apps: [{ app: web, origin: "official" }],
    fetch: internet,
  });
  const maya = await claimed(core);
  const get = (url: string, extra: object = {}) =>
    post(core, "/api/apps/test.web/actions/web.get", { url, ...extra }, maya);
  const grant = (permission: string, granted: boolean) =>
    core.apps.setPermission({
      principal: core.auth.clients.authenticate(maya.token)!,
      appId: "test.web",
      permission,
      granted,
    });
  return { core, internet, get, grant };
}

// An answer that waits until the request is aborted, and says it was asked.
function waitingForAbort() {
  let asked!: () => void;
  const isAsked = new Promise<void>((resolve) => (asked = resolve));
  const answer = (init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      asked();
      init?.signal?.addEventListener("abort", () =>
        reject(init.signal!.reason),
      );
    });
  return { answer, isAsked };
}

describe("apps on the internet", () => {
  it("reach the hosts they hold, and get the answer as text", async () => {
    const { internet, get } = await webCore(
      () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const answered = await get("https://api.example.com/v1/forecast?x=1");

    expect(answered.json()).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    });
    const [url, init] = internet.mock.calls[0]!;
    expect(String(url)).toBe("https://api.example.com/v1/forecast?x=1");
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["another host", "https://other.example.com/"],
    ["plain HTTP", "http://api.example.com/"],
    ["another port", "https://api.example.com:8443/"],
    ["credentials in the URL", "https://maya:secret@api.example.com/"],
    ["something that is not a URL", "api.example.com"],
    ["an address on the home's network", "https://192.168.1.10/"],
    ["the host itself", "https://[::1]/"],
  ])("never reach %s", async (_case, url) => {
    const { core, internet, get } = await webCore(() => new Response("{}"));

    expect((await get(url)).statusCode).toBe(500);
    expect(internet).not.toHaveBeenCalled();
    expect(core.logs.join("\n")).toMatch(
      /test\.web (does not hold|may fetch|asked)/,
    );
  });

  it.each([
    "https://192.168.1.10/",
    "https://2130706433/",
    "https://[::ffff:c0a8:10a]/",
    "https://[64:ff9b::c0a8:101]/",
    "https://[fec0::1]/",
  ])(
    "refuses a non-public address even with its host grant (%s)",
    async (url) => {
      const internet = vi.fn(async () => new Response("{}"));
      const requests = createRequestsUnderWay("test.web");
      const fetch = createNet(internet);

      await expect(
        fetch(
          "test.web",
          {
            permissions: () => [`net:${new URL(url).host}`],
            watch: requests.watch,
          },
          { url },
        ),
      ).rejects.toThrow("may fetch from the public internet only");
      expect(internet).not.toHaveBeenCalled();
    },
  );

  it("refuse an answer larger than 1 MB", async () => {
    const { core, get } = await webCore(
      () => new Response("x".repeat(1024 * 1024 + 1)),
    );

    expect((await get("https://api.example.com/big")).statusCode).toBe(500);
    expect(core.logs.join("\n")).toContain("larger than 1 MB");
  });
});

describe("a request under way", () => {
  it("is aborted once the permission for its host is switched off", async () => {
    const { answer, isAsked } = waitingForAbort();
    const { core, get, grant } = await webCore(answer);

    const answered = get("https://api.example.com/slow");
    await isAsked;
    await grant("net:api.example.com", false);

    expect((await answered).statusCode).toBe(500);
    expect(core.logs.join("\n")).toContain(
      "test.web no longer holds net:api.example.com",
    );
  });

  it("is aborted once the app pauses", async () => {
    const { answer, isAsked } = waitingForAbort();
    const { core, get, grant } = await webCore(answer);

    const answered = get("https://api.example.com/slow");
    await isAsked;
    await grant("places.read", false);

    expect((await answered).statusCode).toBe(500);
    expect(core.logs.join("\n")).toContain("test.web stopped");
  });

  it.each(["revoked", "restored", "paused"])(
    "drops a late answer after the request was cancelled (%s)",
    async (state) => {
      let respond!: () => void;
      const responded = new Promise<void>((resolve) => (respond = resolve));
      let asked!: () => void;
      const isAsked = new Promise<void>((resolve) => (asked = resolve));
      // A fetch that never looks at its signal.
      const { core, get, grant } = await webCore(async () => {
        asked();
        await responded;
        return new Response("{}");
      });

      const answered = get("https://api.example.com/late");
      await isAsked;
      await grant(
        state === "paused" ? "places.read" : "net:api.example.com",
        false,
      );
      if (state === "restored") await grant("net:api.example.com", true);
      // Let pausing abort the request before its response arrives.
      await Promise.resolve();
      respond();

      expect((await answered).statusCode).toBe(500);
      expect(core.logs.join("\n")).toContain(
        state === "paused"
          ? "test.web stopped"
          : "test.web no longer holds net:api.example.com",
      );
    },
  );
});
