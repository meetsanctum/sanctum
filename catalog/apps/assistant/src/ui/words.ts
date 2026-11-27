import type {
  DeviceInfo,
  Hearing,
  HearingFailure,
  RequestLanguage,
} from "@meetsanctum/app-sdk";

// What the Assistant's page says: each language by its own name, what to
// say in it, and how speech recognition is getting on, as plain steps.

/** Each language as it calls itself, in the order the menu lists them. */
export const languageNames: Record<RequestLanguage, string> = {
  en: "English",
  de: "Deutsch",
};

/** A few things to say, in the language the Assistant listens in. */
export function examples(language: RequestLanguage, room: string | null) {
  // A German room takes an article its name decides, so its examples name
  // one that's sure.
  const place = room ?? "Kitchen";
  return language === "de"
    ? [
        { say: "Mach das Licht aus", what: "The lights in the speaker's room" },
        {
          say: "Schalte das Licht im Wohnzimmer ein",
          what: "Any room or floor, by its name",
        },
        {
          say: "Stell das Licht auf vierzig Prozent",
          what: "Or heller and dunkler",
        },
        { say: "Mach das rückgängig", what: "Undoes the last change it made" },
      ]
    : [
        {
          say: "Turn off the lights",
          what: "The lights in the speaker's room",
        },
        {
          say: `Turn on the ${place} lights`,
          what: "Any room or floor, by its name",
        },
        {
          say: "Set the lights to forty percent",
          what: "Or brighter and dimmer",
        },
        { say: "Put it back", what: "Undoes the last change it made" },
      ];
}

/** What it answers anything else, in its language. */
export const notUnderstood: Record<RequestLanguage, string> = {
  en: "I can only help with lights.",
  de: "Ich kann nur mit dem Licht helfen.",
};

/** The first thing to try, in a room the household has. */
export function firstTry(language: RequestLanguage, room: string | null) {
  if (language === "de") return "Mach das Licht aus";
  return room ? `Turn off the ${room} lights` : "Turn off the lights";
}

export type HearingWords = {
  title: string;
  help: string;
  /** The step it's on, with a bar that moves, while it gets ready. */
  step?: string;
  /** Where the household can put it right. */
  action?: "settings" | "addDevices";
};

const failures: Record<HearingFailure, Omit<HearingWords, "step">> = {
  assistant_off: {
    title: "The Assistant is off",
    help: "It's paused, or not allowed to act as your AI assistant. Its settings turn it back on.",
    action: "settings",
  },
  no_sentences: {
    title: "It doesn't speak this language",
    help: "Choose another language below.",
  },
  no_names: {
    title: "Add a room or a light first",
    help: "It learns the names of your rooms and lights, and starts listening once there's one.",
  },
  too_many_names: {
    title: "Too many names to learn",
    help: "Your home has more rooms and lights than speech recognition can learn.",
  },
  memory: {
    title: "Not enough memory for speech recognition",
    help: "Sanctum needs more free memory to listen. It tries again by itself.",
  },
  unavailable: {
    title: "Speech recognition isn't working",
    help: "Sanctum tries again by itself.",
  },
};

/**
 * What the first card says about hearing. `switchingFrom` is the language
 * smart speakers keep hearing in while a new one gets ready.
 */
export function hearingWords(
  hearing: Hearing,
  switchingFrom: RequestLanguage | null,
): HearingWords {
  const name = languageNames[hearing.language];
  if (hearing.state === "failed") return failures[hearing.failure];
  if (hearing.state === "no_speaker") {
    return {
      title: "No smart speaker yet",
      help: "You talk to the Assistant through a smart speaker. Add one, and it shows up here.",
      action: "addDevices",
    };
  }
  if (hearing.state === "ready") {
    return {
      title: "Control your home with your voice",
      help: "Say your speaker's wake word, then what you'd like.",
    };
  }
  const step =
    hearing.state === "downloading"
      ? `Downloading speech recognition for ${name}`
      : "Learning your rooms and lights";
  return switchingFrom && switchingFrom !== hearing.language
    ? {
        title: `Switching to ${name}`,
        help: `${languageNames[switchingFrom]} keeps working until then.`,
        step,
      }
    : {
        title: "Getting ready to listen",
        help: "This takes a few minutes. Until then, your smart speakers won't respond.",
        step,
      };
}

/** A smart speaker's line under its name: its room, and what stops it. */
export function speakerLine(device: DeviceInfo, room: string | null): string {
  const where = room ?? "No room";
  if (device.availability === "offline") {
    return `${where} · Not responding · check its power`;
  }
  const audio = device.capabilities.find(({ kind }) => kind === "audio");
  if ((audio?.state as { muted?: boolean } | undefined)?.muted) {
    return `${where} · Microphones off · turn them on from its page`;
  }
  return room ? room : "No room · say the room when you ask";
}
