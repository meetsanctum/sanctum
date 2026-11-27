import { describe, expect, it } from "vitest";

import { languageIds, languages, speechLanguages } from "../src/index.js";

// The language catalog: each language's names, and the model and voice that
// hear and speak it, the one place Sanctum keeps them.

describe("the language catalog", () => {
  it("lists English and German, both of which Sanctum can speak", () => {
    expect(languageIds).toEqual(["en", "de"]);
    expect(speechLanguages).toEqual(["en", "de"]);
  });

  it("names each language in its own words and in English", () => {
    expect(languages.en.name).toBe("English");
    expect(languages.de).toMatchObject({
      name: "Deutsch",
      englishName: "German",
    });
  });

  it("speaks each language in a voice of that language", () => {
    for (const id of speechLanguages) {
      expect(languages[id].voice).toMatch(new RegExp(`^${id}_[A-Z]{2}-`));
    }
  });
});
