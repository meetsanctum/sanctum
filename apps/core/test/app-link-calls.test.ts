import { ActionError } from "@meetsanctum/app-sdk";
import {
  maxCallsUnderWay,
  maxMessageBytes,
  type CoreMessage,
} from "@meetsanctum/app-sdk/protocol";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";

import { ActionCallError } from "../src/app-host/errors.js";
import {
  action,
  appOnSocket,
  calls,
  gone,
  link,
  listening,
  person,
  readyApp,
  useLink,
  welcomeHello,
} from "./app-link-support.js";

useLink();

describe("calls over an app's socket", () => {
  describe("calling an app", () => {
    it("names the actor the core says, and what it may do is the call's", async () => {
      await listening();
      const app = await readyApp();
      const first = vi.fn(async () => "first's");
      const second = vi.fn(async () => "second's");
      const one = link.call(
        calls({ location: first as never }),
        person,
        action,
        5_000,
      );
      const two = link.call(
        calls({ location: second as never }),
        { kind: "app", id: "test.link" },
        action,
        5_000,
      );
      await vi.waitFor(() =>
        expect(app.heard.filter(({ type }) => type === "call")).toHaveLength(2),
      );
      const [called, other] = app.heard.filter(
        (message): message is Extract<CoreMessage, { type: "call" }> =>
          message.type === "call",
      );

      expect(called).toMatchObject({
        actor: person,
        deadlineMs: 5_000,
        body: action,
      });
      expect((await app.ask(1, called!.id, "location")).outcome).toEqual({
        ok: true,
        value: "first's",
      });
      expect((await app.ask(2, other!.id, "location")).outcome).toEqual({
        ok: true,
        value: "second's",
      });
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      for (const each of [called!, other!]) {
        app.say({ type: "answer", call: each.id, outcome: { ok: true } });
      }
      await Promise.all([one, two]);
    });

    it("gives the call's arguments to the core's call as they came", async () => {
      await listening();
      const device = vi.fn(async () => ({}));
      const app = await readyApp();
      const call = link.call(
        calls({ device: device as never }),
        person,
        action,
        5_000,
      );
      const { id } = await app.hearing("call");

      await app.ask(1, id, "device", ["device:1"]);

      expect(device).toHaveBeenCalledWith("device:1");
      app.say({ type: "answer", call: id, outcome: { ok: true } });
      await call;
    });

    it("carries the core's context behind a call into what the app does for it", async () => {
      await listening();
      const cause = new AsyncLocalStorage<string>();
      let seen: string | undefined;
      const app = await readyApp();
      const call = cause.run("the person's press", () =>
        link.call(
          calls({
            people: async () => {
              seen = cause.getStore();
              return [];
            },
          }),
          person,
          action,
          5_000,
        ),
      );
      const { id } = await app.hearing("call");

      await app.ask(1, id, "people");

      expect(seen).toBe("the person's press");
      app.say({ type: "answer", call: id, outcome: { ok: true } });
      await call;
    });

    it("answers a refusal with its code, and anything else as its failure", async () => {
      await listening();
      const app = await readyApp();
      const call = link.call(
        calls({
          device: async () => {
            throw new ActionError("not_found", "No such device");
          },
          people: async () => {
            throw new Error("It does not hold people.read");
          },
        }),
        person,
        action,
        5_000,
      );
      const { id } = await app.hearing("call");

      expect((await app.ask(1, id, "device", ["x"])).outcome).toEqual({
        ok: false,
        code: "not_found",
        message: "No such device",
      });
      expect((await app.ask(2, id, "people")).outcome).toEqual({
        ok: false,
        message: "It does not hold people.read",
      });
      app.say({ type: "answer", call: id, outcome: { ok: true } });
      await call;
    });

    it("hands on how a call ended, by what its code means", async () => {
      await listening();
      const app = await readyApp();
      const answer = async (outcome: unknown) => {
        const from = app.heard.length;
        const call = link.call(calls({}), person, action, 5_000);
        const { id } = await app.hearing("call", from);
        app.say({ type: "answer", call: id, outcome });
        return call;
      };

      await expect(answer({ ok: true, value: 7 })).resolves.toBe(7);
      await expect(
        answer({ ok: false, code: "conflict", message: "Taken" }),
      ).rejects.toBeInstanceOf(ActionError);
      await expect(
        answer({ ok: false, code: "invalid_request", message: "No" }),
      ).rejects.toBeInstanceOf(ActionCallError);
      const failed = answer({ ok: false, message: "It broke" });
      await expect(failed).rejects.toThrow("It broke");
      await expect(failed).rejects.not.toBeInstanceOf(ActionCallError);
    });

    it("refuses a call to an app with no connection", async () => {
      await listening();

      await expect(
        link.call(calls({}), person, action, 5_000),
      ).rejects.toMatchObject({ code: "unavailable" });
    });

    it("refuses more calls than may be under way", async () => {
      await listening();
      const app = await readyApp();
      const under = Array.from({ length: maxCallsUnderWay }, () =>
        link.call(calls({}), person, action, 5_000).catch(() => undefined),
      );

      await expect(
        link.call(calls({}), person, action, 5_000),
      ).rejects.toMatchObject({ code: "unavailable" });

      app.socket.destroy();
      await Promise.all(under);
    });

    it("fails a call too long for a message, and goes on", async () => {
      await listening();
      await readyApp();

      await expect(
        link.call(
          calls({}),
          person,
          { ...action, input: "x".repeat(maxMessageBytes) },
          5_000,
        ),
      ).rejects.toThrow("over the limit");

      expect(link.isReady()).toBe(true);
    });
  });

  describe("the app's calls under way", () => {
    it("refuses more than may be under way, and takes more once they end", async () => {
      await listening();
      const releases: (() => void)[] = [];
      const app = await readyApp();
      const call = link.call(
        calls({
          people: () => new Promise((done) => releases.push(() => done([]))),
        }),
        person,
        action,
        5_000,
      );
      const { id } = await app.hearing("call");

      for (let at = 1; at <= maxCallsUnderWay; at += 1) {
        app.say({
          type: "request",
          id: at,
          call: id,
          method: "people",
          params: [],
        });
      }
      await vi.waitFor(() => expect(releases).toHaveLength(maxCallsUnderWay));

      expect((await app.ask(1_000, id, "people")).outcome).toMatchObject({
        ok: false,
        message: `More than ${maxCallsUnderWay} calls are under way`,
      });

      releases.splice(0).forEach((release) => release());
      await app.ask(maxCallsUnderWay, id, "people").catch(() => undefined);
      await vi.waitFor(() =>
        expect(app.heard.filter(({ type }) => type === "reply")).toHaveLength(
          maxCallsUnderWay + 1,
        ),
      );
      app.say({
        type: "request",
        id: 2_000,
        call: id,
        method: "people",
        params: [],
      });
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      releases.splice(0).forEach((release) => release());
      app.say({ type: "answer", call: id, outcome: { ok: true } });
      await call;
    });

    it("answers a failure when a reply won't fit a message", async () => {
      await listening();
      const app = await readyApp();
      const call = link.call(
        calls({
          entities: async () => ["x".repeat(maxMessageBytes)] as never,
        }),
        person,
        action,
        5_000,
      );
      const { id } = await app.hearing("call");

      expect((await app.ask(1, id, "entities", ["x"])).outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining("over the limit"),
      });
      app.say({ type: "answer", call: id, outcome: { ok: true } });
      await call;
    });

    it("ends a connection whose app stops reading", async () => {
      await listening({ maxUnreadBytes: 1_024 });
      const app = await readyApp();
      const call = link
        .call(
          // Each is more than Linux's socket buffer holds, as well as the Mac's.
          calls({ entities: async () => ["x".repeat(512 * 1024)] as never }),
          person,
          action,
          5_000,
        )
        .catch(() => undefined);
      const { id } = await app.hearing("call");
      app.socket.pause();

      for (let at = 1; at < 40; at += 1) {
        app.say({
          type: "request",
          id: at,
          call: id,
          method: "entities",
          params: ["x"],
        });
      }

      await vi.waitFor(() => expect(gone).toEqual(["it stopped reading"]), {
        timeout: 4_000,
      });
      await call;
    });
  });

  describe("the start context", () => {
    const start = { kind: "start", reason: "started" } as const;
    const stop = { kind: "stop", reason: "shutdown" } as const;

    it("ends a start context that said it wasn't ready", async () => {
      await listening();
      const people = vi.fn(async () => []);
      const app = await readyApp();
      const starting = link.call(calls({ people }), person, start, 5_000);
      const refused = expect(starting).rejects.toMatchObject({
        name: "NotReady",
      });
      const { id } = await app.hearing("call");
      app.say({
        type: "answer",
        call: id,
        outcome: { ok: false, code: "not_ready", message: "Not yet" },
      });
      await refused;

      expect((await app.ask(1, id, "people")).outcome).toMatchObject({
        ok: false,
      });
      expect(people).not.toHaveBeenCalled();
    });

    it("lasts from start until stop has answered", async () => {
      await listening();
      const people = vi.fn(async () => []);
      const app = await readyApp();
      const starting = link.call(calls({ people }), person, start, 5_000);
      const { id } = await app.hearing("call");
      app.say({ type: "answer", call: id, outcome: { ok: true } });
      await starting;

      // Long after start answered, what it set going can still call.
      expect((await app.ask(1, id, "people")).outcome).toMatchObject({
        ok: true,
      });

      const from = app.heard.length;
      const stopping = link.call(calls({}), person, stop, 5_000);
      const stopCall = await app.hearing("call", from);
      expect((await app.ask(2, id, "people")).outcome).toMatchObject({
        ok: true,
      });
      app.say({ type: "answer", call: stopCall.id, outcome: { ok: true } });
      await stopping;

      expect((await app.ask(3, id, "people")).outcome).toMatchObject({
        ok: false,
      });
    });

    it("outlives its deadline, since what start set going goes on", async () => {
      await listening();
      const people = vi.fn(async () => []);
      const app = await readyApp();
      void link
        .call(calls({ people }), person, start, 10)
        .catch(() => undefined);
      const { id } = await app.hearing("call");

      await new Promise((done) => setTimeout(done, 40));

      expect((await app.ask(1, id, "people")).outcome).toMatchObject({
        ok: true,
      });
    });
  });

  describe("a hung app", () => {
    it("ends the connection when a call stays busy past its grace", async () => {
      await listening({ graceMs: 20 });
      const app = await readyApp();
      const call = link.call(calls({}), person, action, 10);

      await expect(call).rejects.toMatchObject({ code: "unavailable" });

      expect(gone).toEqual([
        "it was still busy with a call 20 ms past its deadline",
      ]);
      await vi.waitFor(() => expect(app.isClosed()).toBe(true));
    });

    it("lets a late answer end the wait, though it counts for nothing more", async () => {
      await listening({ graceMs: 200 });
      const app = await readyApp();
      const call = link.call(calls({}), person, action, 5);
      const { id } = await app.hearing("call");

      await new Promise((done) => setTimeout(done, 15));
      app.say({
        type: "answer",
        call: id,
        outcome: { ok: true, value: "late" },
      });

      await call;
      await new Promise((done) => setTimeout(done, 250));
      expect(gone).toEqual([]);
    });

    it("keeps going while it answers its heartbeat", async () => {
      await listening({ heartbeatMs: 5 });
      const app = await appOnSocket();
      let beats = 0;
      app.socket.on("data", () => {
        for (const message of app.heard.splice(0)) {
          if (message.type === "ping") {
            beats += 1;
            app.say({ type: "pong", beat: message.beat });
          }
        }
      });
      app.say(welcomeHello);
      app.say({ type: "ready" });

      await vi.waitFor(() => expect(beats).toBeGreaterThan(10));

      expect(gone).toEqual([]);
      expect(link.isReady()).toBe(true);
    });

    it("ends the connection after three missed heartbeats", async () => {
      await listening({ heartbeatMs: 5 });
      const app = await readyApp();

      await vi.waitFor(() => expect(gone).toEqual(["it missed 3 heartbeats"]));

      await vi.waitFor(() => expect(app.isClosed()).toBe(true));
    });
  });
});
