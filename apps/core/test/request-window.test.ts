import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRequestWindows,
  windowLimits,
} from "../src/app-host/request-window.js";

// A device's window keeps its last exchanges with the Assistant for 5
// minutes after its last request, within 6 exchanges and 32 KB, with long
// tool answers as stubs.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const asked = (earlier: { asked: string }[]) =>
  earlier.map((each) => each.asked);

describe("a device's request window", () => {
  it("gives the last 6 exchanges, oldest first, for that device only", () => {
    const windows = createRequestWindows();
    for (let index = 1; index <= 8; index += 1) {
      windows.begin("tablet", 1, `Request ${index}`);
    }

    const { earlier } = windows.begin("tablet", 1, "Request 9");
    expect(asked(earlier)).toEqual([
      "Request 3",
      "Request 4",
      "Request 5",
      "Request 6",
      "Request 7",
      "Request 8",
    ]);
    expect(windows.begin("phone", 1, "Hello").earlier).toEqual([]);
  });

  it("keeps a long answer as a stub, a refusal as one, and one still running as unknown", () => {
    const windows = createRequestWindows();
    const { exchange } = windows.begin("tablet", 1, "Look around");
    windows.tool(
      exchange,
      "home_overview",
      {},
    )({
      text: "x".repeat(windowLimits.answerBytes + 1),
      isError: false,
    });
    windows.tool(exchange, "lights", { on: true })(null);
    windows.tool(exchange, "history", {});
    exchange.reply = "Here's the home.";

    const [shown] = windows.begin("tablet", 1, "And now?").earlier;
    expect(shown).toEqual({
      asked: "Look around",
      at: expect.any(String),
      tools: [
        {
          name: "home_overview",
          input: {},
          outcome: "too_long",
          isError: false,
        },
        {
          name: "lights",
          input: { on: true },
          outcome: "answered",
          text: "The call was refused.",
          isError: true,
        },
        { name: "history", input: {}, outcome: "unknown" },
      ],
      reply: "Here's the home.",
      cutOff: false,
    });
  });

  it("leaves out the oldest exchanges beyond 32 KB", () => {
    const windows = createRequestWindows();
    for (let index = 1; index <= 3; index += 1) {
      const { exchange } = windows.begin("tablet", 1, `Request ${index}`);
      // About 12 KB an exchange, each answer just under the stub's size.
      for (let call = 0; call < 3; call += 1) {
        windows.tool(
          exchange,
          "lights",
          {},
        )({
          text: "x".repeat(windowLimits.answerBytes - 100),
          isError: false,
        });
      }
    }

    const { earlier } = windows.begin("tablet", 1, "Request 4");
    expect(asked(earlier)).toEqual(["Request 2", "Request 3"]);
    expect(Buffer.byteLength(JSON.stringify(earlier))).toBeLessThanOrEqual(
      windowLimits.bytes,
    );
  });

  it("goes 5 minutes after the device's last request, or as the Assistant runs anew", () => {
    const windows = createRequestWindows();
    windows.begin("tablet", 1, "First");
    vi.advanceTimersByTime(windowLimits.ms - 1);
    expect(asked(windows.begin("tablet", 1, "Second").earlier)).toEqual([
      "First",
    ]);

    vi.advanceTimersByTime(windowLimits.ms);
    expect(windows.begin("tablet", 1, "Third").earlier).toEqual([]);

    expect(windows.begin("tablet", 2, "Fourth").earlier).toEqual([]);
    windows.clear();
    expect(windows.begin("tablet", 2, "Fifth").earlier).toEqual([]);
  });
});
