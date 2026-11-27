// Every language Sanctum knows, one entry each: what it's called, and the
// speech recognition model and Piper voice that hear and speak it. A
// language with both can be spoken.

/** What Sanctum knows about one language. */
export type LanguageEntry = {
  /** Its name in its own words, as a list of languages shows it: "Deutsch". */
  readonly name: string;
  /** Its name in English, as AI agents read it: "German". */
  readonly englishName: string;
  /**
   * The speech recognition model that hears it, by Speech-to-Phrase's
   * backend and model name as its image picks them for the language, or
   * null when none does.
   */
  readonly recognition: {
    readonly backend: "nemo";
    readonly model: string;
  } | null;
  /**
   * The Piper voice that speaks it, trained on recordings free to use, or
   * null when none does.
   */
  readonly voice: string | null;
};

export const languages = {
  en: {
    name: "English",
    englishName: "English",
    recognition: { backend: "nemo", model: "stt_en_parakeet_tdt_ctc_110m" },
    voice: "en_US-norman-medium",
  },
  de: {
    name: "Deutsch",
    englishName: "German",
    recognition: { backend: "nemo", model: "stt_de_citrinet_1024" },
    voice: "de_DE-thorsten-medium",
  },
} as const satisfies Record<string, LanguageEntry>;

/** A language Sanctum knows, by its catalog id. */
export type Language = keyof typeof languages;

/** Every language, in the catalog's order. */
export const languageIds = Object.keys(languages) as Language[];

type Spoken<Id extends Language> = (typeof languages)[Id] extends {
  recognition: object;
  voice: string;
}
  ? Id
  : never;

/** A language with a model that hears it and a voice that speaks it. */
export type SpeechLanguage = { [Id in Language]: Spoken<Id> }[Language];

const spoken = (language: Language): language is SpeechLanguage => {
  const entry: LanguageEntry = languages[language];
  return entry.recognition !== null && entry.voice !== null;
};

/** Every language that can be spoken, in the catalog's order. */
export const speechLanguages: SpeechLanguage[] = languageIds.filter(spoken);
