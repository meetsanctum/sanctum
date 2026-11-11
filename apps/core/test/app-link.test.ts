import type { CoreCalls } from "@meetsanctum/app-sdk";
import {
  maxMessageBytes,
  protocolVersion,
} from "@meetsanctum/app-sdk/protocol";
import { stat, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  action,
  appOnSocket,
  calls,
  gone,
  link,
  listening,
  logs,
  person,
  ready,
  readyApp,
  socketPath,
  useLink,
  welcomeHello,
} from "./app-link-support.js";

useLink();

describe("the core's end of an app's socket", () => {
  describe("what an app must say first", () => {
    it("welcomes the version it expects, then waits for it to be ready", async () => {
      await listening();
      const app = await appOnSocket();

      app.say(welcomeHello);

      expect(await app.hearing("welcome")).toEqual({
        type: "welcome",
        generation: 1,
      });
      expect(link.isReady()).toBe(false);
      expect(ready).toBe(0);

      app.say({ type: "ready" });

      await vi.waitFor(() => expect(ready).toBe(1));
      expect(link.isReady()).toBe(true);
    });

    it.each([
      ["another protocol", { protocol: protocolVersion + 1 }, "protocol"],
      ["another app", { app: "test.other" }, "test.other"],
      ["another version", { version: "9.9.9" }, "9.9.9"],
      ["another manifest", { manifest: "c".repeat(64) }, "manifest"],
    ])("refuses %s and says why", async (_what, changed, says) => {
      await listening();
      const app = await appOnSocket();

      app.say({ ...welcomeHello, ...changed });

      expect((await app.hearing("refused")).reason).toContain(says);
      await vi.waitFor(() => expect(app.isClosed()).toBe(true));
      expect(ready).toBe(0);
      expect(logs.join()).toContain("was refused");
    });

    it("ends a connection that does anything else first", async () => {
      await listening();
      const app = await appOnSocket();

      app.say({ type: "ready" });

      await vi.waitFor(() => expect(app.isClosed()).toBe(true));
      expect(ready).toBe(0);
    });

    it("ends a connection that says nothing in time", async () => {
      await listening({ helloWithinMs: 10 });
      const app = await appOnSocket();

      await vi.waitFor(() => expect(app.isClosed()).toBe(true));
    });

    it("ends a connection that doesn't get ready in time", async () => {
      await listening({ readyWithinMs: 10 });
      const app = await appOnSocket();
      app.say(welcomeHello);

      await vi.waitFor(() => expect(app.isClosed()).toBe(true));

      expect(gone).toEqual(["it didn't get ready in time"]);
    });

    it("hears why one couldn't get ready", async () => {
      await listening();
      const app = await appOnSocket();
      app.say(welcomeHello);
      await app.hearing("welcome");

      app.say({ type: "failed", message: "Its migration failed" });

      await vi.waitFor(() =>
        expect(gone).toEqual(["it could not get ready: Its migration failed"]),
      );
      expect(link.isReady()).toBe(false);
    });

    it("sends no heartbeat while it gets ready, since migrating blocks it", async () => {
      await listening({ heartbeatMs: 5 });
      const app = await appOnSocket();
      app.say(welcomeHello);
      await app.hearing("welcome");

      await new Promise((done) => setTimeout(done, 40));

      expect(app.heard.map(({ type }) => type)).toEqual(["welcome"]);
      expect(gone).toEqual([]);
    });
  });

  describe("what breaks the protocol ends the connection", () => {
    it.each([
      ["a line that isn't JSON", "not json\n"],
      ["a message of no known type", `${JSON.stringify({ type: "nope" })}\n`],
      [
        "a request with two arguments",
        `${JSON.stringify({
          type: "request",
          id: 1,
          call: "1.1",
          method: "people",
          params: [1, 2],
        })}\n`,
      ],
      ["a line over the limit", "x".repeat(maxMessageBytes + 1)],
      ["a second hello", `${JSON.stringify(welcomeHello)}\n`],
    ])("%s", async (_what, line) => {
      await listening();
      const app = await readyApp();

      app.socket.write(line);

      await vi.waitFor(() => expect(app.isClosed()).toBe(true));
      expect(gone).toHaveLength(1);
      expect(link.isReady()).toBe(false);
    });

    it("fails the calls under way when it does", async () => {
      await listening();
      const app = await readyApp();
      const call = link.call(calls({}), person, action, 5_000);

      app.socket.write("not json\n");

      await expect(call).rejects.toMatchObject({ code: "unavailable" });
    });
  });

  describe("forged calls", () => {
    it("refuses what names a call the core never issued, and goes on", async () => {
      await listening();
      const people = vi.fn(async () => []);
      const app = await readyApp();
      const call = link.call(calls({ people }), person, action, 5_000);
      const { id } = await app.hearing("call");

      const forged = await app.ask(1, "1.999", "people");
      const another = await app.ask(2, "../../etc/passwd", "people");

      expect(forged.outcome).toMatchObject({
        ok: false,
        message: "The call 1.999 has ended",
      });
      expect(another.outcome).toMatchObject({ ok: false });
      expect(people).not.toHaveBeenCalled();

      // The real one still works.
      expect((await app.ask(3, id, "people")).outcome).toEqual({
        ok: true,
        value: [],
      });
      app.say({ type: "answer", call: id, outcome: { ok: true } });
      await call;
      expect(link.isReady()).toBe(true);
    });

    it("refuses what names a call that has ended", async () => {
      await listening();
      const people = vi.fn(async () => []);
      const app = await readyApp();
      const call = link.call(calls({ people }), person, action, 5_000);
      const { id } = await app.hearing("call");
      app.say({ type: "answer", call: id, outcome: { ok: true } });
      await call;

      expect((await app.ask(1, id, "people")).outcome).toMatchObject({
        ok: false,
        message: `The call ${id} has ended`,
      });
      expect(people).not.toHaveBeenCalled();
    });

    it("refuses what names a call past its deadline, though it hasn't answered", async () => {
      await listening();
      const people = vi.fn(async () => []);
      const app = await readyApp();
      void link
        .call(calls({ people }), person, action, 10)
        .catch(() => undefined);
      const { id } = await app.hearing("call");

      await new Promise((done) => setTimeout(done, 40));

      expect((await app.ask(1, id, "people")).outcome).toMatchObject({
        ok: false,
      });
      expect(people).not.toHaveBeenCalled();
    });

    it.each([
      "query",
      "log",
      "nonsense",
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
    ])("refuses %s, which isn't a call that crosses", async (method) => {
      await listening();
      const query = vi.fn();
      const app = await readyApp();
      const call = link.call(
        calls({ query, log: query } as Partial<CoreCalls>),
        person,
        action,
        5_000,
      );
      const { id } = await app.hearing("call");

      expect((await app.ask(1, id, method)).outcome).toEqual({
        ok: false,
        message: `There is no call ${method}`,
      });
      expect(query).not.toHaveBeenCalled();
      app.say({ type: "answer", call: id, outcome: { ok: true } });
      await call;
    });

    it("changes nothing with an answer to nothing, or a second one", async () => {
      await listening();
      const app = await readyApp();
      const call = link.call(calls({}), person, action, 5_000);
      const { id } = await app.hearing("call");

      app.say({
        type: "answer",
        call: "1.999",
        outcome: { ok: true, value: "forged" },
      });
      app.say({ type: "answer", call: id, outcome: { ok: true, value: "it" } });
      app.say({
        type: "answer",
        call: id,
        outcome: { ok: true, value: "again" },
      });

      expect(await call).toBe("it");
      await app.ask(1, "1.999", "people");
      expect(link.isReady()).toBe(true);
    });
  });

  describe("generations", () => {
    it("counts each new connection, which takes over from the last", async () => {
      await listening();
      const old = await readyApp();
      const failed = expect(
        link.call(calls({}), person, action, 5_000),
      ).rejects.toMatchObject({ code: "unavailable" });

      const next = await appOnSocket();
      next.say(welcomeHello);

      expect(await next.hearing("welcome")).toEqual({
        type: "welcome",
        generation: 2,
      });
      await failed;
      await vi.waitFor(() => expect(old.isClosed()).toBe(true));
      expect(gone).toEqual(["a new connection took over"]);
    });

    it("leaves the connection it has when a new one is refused", async () => {
      await listening();
      const old = await readyApp();

      const next = await appOnSocket();
      next.say({ ...welcomeHello, version: "9.9.9" });
      await next.hearing("refused");

      expect(old.isClosed()).toBe(false);
      expect(link.isReady()).toBe(true);
      expect(gone).toEqual([]);
    });

    it("answers nothing from the old connection", async () => {
      await listening();
      let release!: (value: never[]) => void;
      const old = await readyApp();
      const call = link
        .call(
          calls({
            people: () => new Promise((done) => (release = done)),
          }),
          person,
          action,
          5_000,
        )
        .catch(() => undefined);
      const { id } = await old.hearing("call");
      old.say({
        type: "request",
        id: 1,
        call: id,
        method: "people",
        params: [],
      });
      await vi.waitFor(() => expect(release).toBeDefined());

      const next = await readyApp();
      release([]);
      await call;
      await new Promise((done) => setTimeout(done, 20));

      expect(old.heard.some(({ type }) => type === "reply")).toBe(false);
      expect(next.heard.some(({ type }) => type === "reply")).toBe(false);
    });

    it("doesn't take an old connection's id on a new one", async () => {
      await listening();
      const people = vi.fn(async () => []);
      const old = await readyApp();
      void link
        .call(calls({ people }), person, action, 5_000)
        .catch(() => undefined);
      const { id } = await old.hearing("call");

      const next = await readyApp();

      expect((await next.ask(1, id, "people")).outcome).toMatchObject({
        ok: false,
      });
      expect(people).not.toHaveBeenCalled();
    });
  });

  describe("its socket", () => {
    it("takes the place of one a core before it left, and lets the app's user connect", async () => {
      await listening();
      await link.close();
      await writeFile(socketPath, "");

      await listening();
      const app = await readyApp();

      expect(app.isClosed()).toBe(false);
      expect((await stat(socketPath)).mode & 0o777).toBe(0o666);
    });

    it("says nothing to the core when it closes", async () => {
      await listening();
      await readyApp();

      await link.close();

      expect(gone).toEqual([]);
      await expect(stat(socketPath)).rejects.toThrow("ENOENT");
      await listening();
    });
  });
});
