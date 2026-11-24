import { describe, expect, it } from "vitest";

import { activityWords } from "../src/activity/words";
import { entry } from "./activity-fixtures";

describe("Activity for AI agents and models", () => {
  it("names an AI agent and who added it", () => {
    const agent = (
      addedBy: {
        kind: "person" | "client";
        id: string;
        name: string | null;
      } | null,
    ) =>
      activityWords(
        entry({
          who: {
            kind: "agent",
            id: "codex",
            name: "Codex on the office Mac",
            addedBy,
          },
        }),
        "device",
      ).detail;

    expect(agent({ kind: "person", id: "sam", name: "Sam" })).toBe(
      "Codex on the office Mac, added by Sam",
    );
    expect(agent({ kind: "person", id: "sam", name: null })).toBe(
      "Codex on the office Mac, added by someone who has left",
    );
    expect(agent(null)).toBe("Codex on the office Mac");
  });

  it.each([
    { kind: "person", name: "Sam", expected: "asked by Sam" },
    { kind: "person", name: null, expected: "asked by someone who has left" },
    {
      kind: "client",
      name: "Kitchen Tablet",
      expected: "asked from Kitchen Tablet",
    },
    { kind: "client", name: null, expected: "asked from a shared device" },
  ] as const)(
    "names who asked the assistant ($expected)",
    ({ kind, name, expected }) => {
      const words = activityWords(
        entry({
          who: {
            kind: "agent",
            id: "assistant",
            name: "Assistant",
            addedBy: null,
            askedBy: { kind, id: "opener", name },
          },
        }),
        "device",
      );
      expect(words.detail).toBe(`Assistant, ${expected}`);
    },
  );

  it("describes an agent being removed", () => {
    const words = activityWords(
      entry({
        action: "client.revoke",
        detail: { kind: "agent", name: "Office agent" },
        subject: {
          type: "client",
          id: "agent",
          name: "Office agent",
          gone: true,
        },
      }),
    );

    expect(words.title).toBe("Removed Office agent");
  });

  it("keeps the name given to an agent in the rename entry", () => {
    const words = activityWords(
      entry({
        action: "client.rename",
        detail: { kind: "agent", name: "Office agent" },
        subject: {
          type: "client",
          id: "agent",
          name: "Study agent",
          gone: false,
        },
      }),
    );

    expect(words.title).toBe("Renamed an AI agent to Office agent");
  });

  it("names what the household let AI agents use, or stopped", () => {
    const area = activityWords(
      entry({
        action: "agents.can-use",
        detail: { item: "people.read", on: true },
      }),
    );
    const offer = activityWords(
      entry({
        action: "agents.can-use",
        detail: {
          app: "sanctum.moods",
          item: "moods.run",
          title: "Run a mood",
          on: false,
        },
      }),
    );

    expect(area.title).toBe("Let AI agents use “See who lives here”");
    expect(offer.title).toBe("Stopped AI agents using “Run a mood”");
  });

  it("says when an AI agent was held back for asking too much", () => {
    const words = (reason: string) =>
      activityWords(
        entry({
          action: "agents.limited",
          outcome: "refused",
          reason,
          who: {
            kind: "agent",
            id: "agent-1",
            name: "Codex on the office Mac",
            addedBy: null,
          },
        }),
      );

    expect(words("per_minute").title).toBe("Held back for asking too often");
    expect(words("at_once").title).toBe(
      "Held back for asking too much at once",
    );
    expect(words("commands").title).toBe(
      "Held back for changing devices too often",
    );
  });

  it("says how an app's turn with the AI model went, never what was said", () => {
    const turn = (outcome: "ok" | "failed", detail: Record<string, unknown>) =>
      activityWords(entry({ action: "models.turn", outcome, detail })).title;
    const asked = {
      app: "sanctum.example",
      appName: "Example",
      kind: "computer",
      model: "Qwen3 8B",
      computer: "Office Mac",
      answers: 2,
      tokens: 1_234,
      ms: 4_200,
    };

    expect(turn("ok", asked)).toBe(
      "Example asked Qwen3 8B on Office Mac: 1,234 tokens in 4.2 s",
    );
    expect(turn("failed", asked)).toBe(
      "Qwen3 8B on Office Mac didn't answer Example",
    );
    expect(turn("failed", { appName: "Example", answers: 1 })).toBe(
      "Example asked the AI model, but none was in use",
    );
    expect(
      turn("ok", { ...asked, models: [asked, { model: "Llama3.2 3B" }] }),
    ).toBe("Example asked multiple AI models: 1,234 tokens in 4.2 s");
  });

  it("names what an AI agent wasn't allowed, by its switch's words", () => {
    const words = (items: string[]) =>
      activityWords(
        entry({
          action: "agents.refused",
          outcome: "refused",
          reason: "forbidden",
          detail: { tool: "lights", items },
          who: {
            kind: "agent",
            id: "agent-1",
            name: "Codex on the office Mac",
            addedBy: null,
          },
        }),
      );

    expect(words(["devices.control:light"]).title).toBe(
      "Not allowed: “Control your lights”",
    );
    expect(words([]).title).toBe("Not allowed to read what apps bring");
  });

  it("says how an AI agent was added", () => {
    const words = (fields: Partial<Parameters<typeof entry>[0]>) =>
      activityWords(entry({ outcome: "ok", ...fields }));

    expect(
      words({
        action: "agents.setup",
        detail: { name: "Codex on the office Mac" },
      }).title,
    ).toBe("Started adding Codex on the office Mac");
    expect(words({ action: "agents.setup-cancel" }).title).toBe(
      "Stopped adding an AI agent",
    );
    expect(
      words({
        action: "agents.add",
        subject: { type: "client", id: "agent-1", name: "Codex", gone: false },
      }).title,
    ).toBe("Added Codex");
    const wrong = words({
      action: "agents.add",
      outcome: "refused",
      reason: "wrong_secret",
    });
    expect(wrong.title).toBe(
      "Someone tried a wrong code for adding an AI agent",
    );
    expect(wrong.problem).toBe(true);
    const held = words({
      action: "agents.add",
      outcome: "refused",
      reason: "too_many_attempts",
    });
    expect(held.title).toBe(
      "Held back a computer trying codes for adding an AI agent",
    );
    expect(held.problem).toBe(true);
  });
});
