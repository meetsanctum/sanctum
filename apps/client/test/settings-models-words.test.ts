import { homeClock } from "@meetsanctum/app-sdk/clock";
import { describe, expect, it } from "vitest";

import { checkLine, sourceDetail, sourceName } from "../src/models/words";
import { mac, now, router } from "./settings-models-fixtures";

// The device's own zone, which the expectations here are worked out in.
const clock = homeClock();

describe("the words for AI models", () => {
  it("names a source by its model and where it runs", () => {
    expect(sourceName(mac)).toBe("Qwen3 8B on Office Mac");
    expect(sourceName(router)).toBe("OpenAI: GPT-5 Mini with OpenRouter");
    const sanctum = { ...mac, kind: "sanctum" as const, computer: undefined };
    expect(sourceName(sanctum)).toBe("Qwen3 8B on Sanctum");
    expect(sourceDetail(sanctum)).toBe("Ollama");
    expect(sourceDetail(mac)).toBe("Ollama at 192.168.1.40:11434");
    expect(sourceDetail(router)).toBe("Key ending in 4f2a");
  });

  it("says how the last check went", () => {
    // A check that went well leaves the row quiet.
    expect(checkLine(clock, mac)).toBeUndefined();
    expect(checkLine(clock, router)?.text).toBe(
      "Answered, but may not use your home's AI tools well or act on your devices",
    );
    expect(
      checkLine(clock, {
        ...mac,
        check: {
          at: now.toISOString(),
          outcome: "failed",
          problem: "unreachable",
        },
      }),
    ).toMatchObject({
      text: expect.stringContaining("Nothing answered at 192.168.1.40:11434"),
      tone: "problem",
    });
    expect(
      checkLine(clock, { ...mac, downSince: "2026-11-23T11:02:00Z" })?.text,
    ).toContain("Check that Office Mac is awake and Ollama is running there.");
    expect(
      checkLine(clock, {
        ...router,
        downSince: "2026-11-23T11:02:00Z",
        check: { at: now.toISOString(), outcome: "failed", problem: "key" },
      })?.text,
    ).toContain("OpenRouter didn't take that key.");
    expect(checkLine(clock, { ...mac, checking: true })?.tone).toBe("plain");
  });
});
