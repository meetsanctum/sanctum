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

const germanRoomCommand = "Mach das Licht aus";

/** A few things to say, in the language the Assistant listens in. */
export function examples(language: RequestLanguage, room: string | null) {
  // A German room takes an article its name decides, so its examples name
  // one that's sure.
  const place = room ?? "Kitchen";
  return language === "de"
    ? [
        { say: germanRoomCommand, what: "The lights in the speaker's room" },
        {
          say: "Schalte das Licht im Wohnzimmer ein",
          what: "Any room or floor, by its name",
        },
        {
          say: "Stell das Licht auf vierzig Prozent",
          what: "Or heller and dunkler",
        },
        {
          say: "Stell das Wohnzimmer auf Abend",
          what: "A room's mood, by its name",
        },
        {
          say: "Mach das rückgängig",
          what: "Undoes the last light change if no mood has run since",
        },
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
        {
          say: `Set the ${place} to Evening`,
          what: "A room's mood, by its name",
        },
        {
          say: "Put it back",
          what: "Undoes the last light change if no mood has run since",
        },
      ];
}

/** The first thing to try, in a room the household has. */
export function firstTry(language: RequestLanguage, room: string) {
  return language === "de" ? germanRoomCommand : `Turn off the ${room} lights`;
}

export const assignSpeakerRoom =
  "Assign a room to a smart speaker to try a command.";

/** What the first card says when every online smart speaker is muted. */
export const mutedWords = {
  title: "Microphones off",
  help: "All online smart speakers are muted. Turn their microphones on from a speaker's page.",
};

export type HearingWords = {
  title: string;
  help: string;
  /** The step it's on, with a bar that moves, while it gets ready. */
  step?: string;
  /** Where the household can put it right. */
  action?: "addDevices";
};

// The shell says when the Assistant is off or paused, and opens its
// settings, so the page adds nothing for that.
const failures: Record<
  Exclude<HearingFailure, "assistant_off">,
  Omit<HearingWords, "step">
> = {
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
    help: "Speech recognition needs more free memory. It tries again by itself.",
  },
  unavailable: {
    title: "Speech recognition isn't working",
    help: "Speech recognition tries again by itself.",
  },
};

/** What the first card says about hearing, or null for the shell to say. */
export function hearingWords(hearing: Hearing): HearingWords | null {
  const { activeLanguage } = hearing;
  const name = languageNames[hearing.language];
  if (hearing.state === "failed") {
    return hearing.failure === "assistant_off"
      ? null
      : failures[hearing.failure];
  }
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
  return activeLanguage && activeLanguage !== hearing.language
    ? {
        title: `Switching to ${name}`,
        help: `${languageNames[activeLanguage]} keeps working until then.`,
        step,
      }
    : {
        title: "Getting ready to listen",
        help: activeLanguage
          ? `You can still speak ${languageNames[activeLanguage]}.`
          : "This takes a few minutes. Until then, your smart speakers won't respond.",
        step,
      };
}

/** The audio capability whose microphones listen for requests. */
export function listeningAudio(device: DeviceInfo) {
  for (const part of device.capabilities) {
    if (part.kind === "audio" && part.features.listens) return part;
  }
}

/** A smart speaker's line under its name: its room, and what stops it. */
export function speakerLine(device: DeviceInfo, room: string | null): string {
  const where = room ?? "No room";
  if (device.availability === "offline") {
    return `${where} · Not responding · check its power`;
  }
  if (listeningAudio(device)?.state?.muted) {
    return `${where} · Microphones off · turn them on from its page`;
  }
  return room ? room : "No room · say the room when you ask";
}
