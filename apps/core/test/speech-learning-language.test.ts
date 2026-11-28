import { describe, expect, it, vi } from "vitest";

import * as words from "../src/speech/words.js";
import { learningSetup } from "./speech-learning-support.js";
import { fakeSpeechToPhrase } from "./speech-support.js";
import { deferredResult } from "./support.js";

describe("when the home's speech language changes", () => {
  it("learns a new language at once, hearing in the old one until it can", async () => {
    const fake = await fakeSpeechToPhrase({
      transcript: "turn on the office lights",
    });
    const sentences = {
      en: ["turn (on|off) the {room} lights"],
      de: ["schalte das licht im {room} (ein|aus)"],
    };
    const { learning, hearings, setLanguage } = learningSetup(fake, {
      sentences,
    });
    try {
      learning.start();
      await vi.waitFor(() => expect(learning.hearing().state).toBe("ready"));
      expect(hearings).toEqual([
        {
          state: "downloading",
          language: "en",
          speechLanguage: "en",
          activeLanguage: null,
        },
        {
          state: "ready",
          language: "en",
          speechLanguage: "en",
          activeLanguage: "en",
        },
      ]);
      expect(learning.hearsIn()).toBe("en");

      setLanguage("de");
      learning.languageChanged();
      // Not a minute later: the new language is learned now.
      await vi.waitFor(() =>
        expect(fake.lessons.at(-1)).toMatchObject({ language: "de" }),
      );
      await vi.waitFor(() =>
        expect(learning.hearing()).toEqual({
          state: "ready",
          language: "de",
          speechLanguage: "de",
          activeLanguage: "de",
        }),
      );
      expect(learning.hearsIn()).toBe("de");
      expect(hearings.slice(2)).toEqual([
        // The service had only English loaded.
        {
          state: "downloading",
          language: "de",
          speechLanguage: "de",
          activeLanguage: "en",
        },
        {
          state: "ready",
          language: "de",
          speechLanguage: "de",
          activeLanguage: "de",
        },
      ]);
    } finally {
      learning.stop();
      fake.server.close();
    }
  });

  it("keeps hearing with the old lesson when the new language has no sentences", async () => {
    const models = vi.spyOn(words, "describeLanguages").mockResolvedValue([]);
    const teach = vi
      .spyOn(words, "train")
      .mockResolvedValue({ digest: "en", changed: true });
    const { learning, manager, setLanguage } = learningSetup({
      url: "tcp://127.0.0.1:10300",
    });
    try {
      learning.start();
      await vi.waitFor(() => expect(learning.hearsIn()).toBe("en"));
      setLanguage("de");
      learning.languageChanged();
      expect(learning.hearing()).toEqual({
        state: "failed",
        language: "de",
        speechLanguage: "de",
        activeLanguage: "en",
        failure: "no_sentences",
      });
      expect(learning.hearsIn()).toBe("en");
      expect(learning.notHearing()).toBeNull();
      expect(learning.transcriber()).toBeTypeOf("function");
      expect(teach).toHaveBeenCalledOnce();
      expect(manager.releaseServiceForCore).not.toHaveBeenCalled();
    } finally {
      learning.stop();
      models.mockRestore();
      teach.mockRestore();
    }
  });

  it("waits for submitted training before teaching the latest language", async () => {
    const german = deferredResult<{
      digest: string;
      changed: boolean;
    }>();
    const models = vi
      .spyOn(words, "describeLanguages")
      .mockResolvedValue(["en", "de"]);
    const teach = vi
      .spyOn(words, "train")
      .mockResolvedValueOnce({ digest: "en", changed: true })
      .mockReturnValueOnce(german.promise)
      .mockResolvedValueOnce({ digest: "en", changed: true });
    const { learning, setLanguage } = learningSetup(
      { url: "tcp://127.0.0.1:10300" },
      { sentences: { en: ["lights on"], de: ["licht an"] } },
    );
    try {
      learning.start();
      await vi.waitFor(() => expect(learning.hearsIn()).toBe("en"));
      setLanguage("de");
      learning.languageChanged();
      await vi.waitFor(() => expect(teach).toHaveBeenCalledTimes(2));
      expect(learning.hearing()).toEqual({
        state: "learning",
        language: "de",
        speechLanguage: "de",
        activeLanguage: "en",
      });

      setLanguage("en");
      learning.languageChanged();
      expect(teach).toHaveBeenCalledTimes(2);
      expect(teach.mock.calls[1]?.[0].signal?.aborted).toBe(false);
      expect(learning.hearing()).toEqual({
        state: "learning",
        language: "en",
        speechLanguage: "en",
        activeLanguage: "en",
      });

      german.resolve({ digest: "de", changed: true });
      await vi.waitFor(() =>
        expect(learning.hearing()).toEqual({
          state: "ready",
          language: "en",
          speechLanguage: "en",
          activeLanguage: "en",
        }),
      );
      expect(teach.mock.calls.map(([call]) => call.lesson.language)).toEqual([
        "en",
        "de",
        "en",
      ]);
    } finally {
      learning.stop();
      models.mockRestore();
      teach.mockRestore();
    }
  });

  it("does not publish a previous language's lesson failure", async () => {
    const { learning, hearings, setLanguage } = learningSetup(
      { url: "" },
      {
        sentences: {
          en: ["set the mood to {mood}"],
          de: ["licht an"],
        },
      },
    );
    try {
      learning.start();
      await vi.waitFor(() =>
        expect(learning.hearing()).toMatchObject({ failure: "no_names" }),
      );
      setLanguage("de");
      learning.languageChanged();
      expect(hearings.filter(({ language }) => language === "de")).toEqual([
        {
          state: "downloading",
          language: "de",
          speechLanguage: "de",
          activeLanguage: null,
        },
      ]);
    } finally {
      learning.stop();
    }
  });
});
