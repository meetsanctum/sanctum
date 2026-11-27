import { describe, expect, expectTypeOf, it } from "vitest";

import {
  languageIds,
  languages,
  requestLanguages,
  speechLanguages,
  type RequestLanguage,
} from "../src/index.js";
import recognitionModels from "../src/recognition-models.json" with { type: "json" };
import { supportsSpeech } from "../src/speech-support.js";

describe("the language catalog", () => {
  it("lists English and German, both of which Sanctum can speak", () => {
    expect(languageIds).toEqual(["en", "de"]);
    expect(speechLanguages).toEqual(["en", "de"]);
  });

  it("preserves the request language exports", () => {
    expect(requestLanguages).toEqual(["en", "de"]);
    expectTypeOf(requestLanguages).toEqualTypeOf<readonly ["en", "de"]>();
    expectTypeOf<RequestLanguage>().toEqualTypeOf<"en" | "de">();
  });

  it("names each language in its own words and in English", () => {
    expect(languages.en.name).toBe("English");
    expect(languages.de).toMatchObject({
      name: "Deutsch",
      englishName: "German",
    });
  });

  it("uses the English and German Piper voice IDs", () => {
    expect(languages.en.voice).toBe("en_US-norman-medium");
    expect(languages.de.voice).toBe("de_DE-thorsten-medium");
  });

  it("lists the models reported by the Speech-to-Phrase image", () => {
    const models = languageIds.flatMap((language) => {
      const { recognition } = languages[language];
      return recognition === null ? [] : [[language, recognition]];
    });
    expect(Object.fromEntries(models)).toEqual(recognitionModels);
  });

  it("requires both a recognition model and a voice for speech", () => {
    expect(supportsSpeech(languages.en)).toBe(true);
    expect(supportsSpeech({ ...languages.en, recognition: null })).toBe(false);
    expect(supportsSpeech({ ...languages.en, voice: null })).toBe(false);
  });
});
