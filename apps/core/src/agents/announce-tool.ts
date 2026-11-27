import {
  announcePermission,
  languages,
  speechLanguages,
  type AiCanUse,
  type DeviceInfo,
  type SpeechLanguage,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import type { ActivityAuthor, NewActivityEntry } from "../activity/activity.js";
import { announcementCapability } from "../devices/announce.js";
import { AnnouncementRefused } from "../speech/announcements.js";
import {
  SpeechSwitchedOff,
  SpeechUnavailable,
  type Speech,
} from "../speech/speech.js";
import {
  answer,
  errorAnswer,
  invalidInput,
  notInstructions,
  toolError,
} from "./answers.js";
import { areasOff, inputSchemaOf, isOn, type CoreTool } from "./core-tool.js";
import { minuteWindows } from "./limits.js";

// `announce`: an AI agent has Sanctum say something out loud on a smart
// speaker, in the home's voice, while "Speak on your smart speakers" is on.
// The words are the agent's; the voice is always Sanctum's own, so an agent
// can say "Dinner's ready", never play a recording. A speaker says one thing
// at a time, the next waiting its turn, and a few a minute is all an agent or
// a speaker gets, so an agent can't talk over the household.

/** The most an announcement says, in characters. */
export const maxAnnouncementText = 300;

// Why a speaker wouldn't be heard: checked when asked, and again when an
// announcement that waited its turn is about to play.
class NotHeard extends Error {
  constructor(readonly answer: ReturnType<typeof toolError>) {
    super("The speaker wouldn't be heard");
  }
}

const announceLimits = {
  // Each agent's, and the home's, in the last minute.
  agent: { agentPerMinute: 6, homePerMinute: 20 },
  // Each speaker's, whoever asks.
  speaker: { agentPerMinute: 4, homePerMinute: Number.POSITIVE_INFINITY },
};

export function createAnnounceTool(options: {
  devices: { list(): DeviceInfo[]; get(id: string): DeviceInfo | null };
  speech: Pick<Speech, "speak">;
  // The home's language for speech.
  language: () => SpeechLanguage;
  record: (entry: NewActivityEntry) => string;
  agentWho: (id: string) => ActivityAuthor;
  now?: () => number;
}): CoreTool {
  const now = options.now ?? (() => performance.now());
  const byAgent = minuteWindows(announceLimits.agent, now);
  const bySpeaker = minuteWindows(announceLimits.speaker, now);

  const speakers = () => options.devices.list().filter(announcementCapability);

  const noSpeaker = () =>
    toolError("not_found", "There's no such smart speaker in the home.");

  function heard(device: DeviceInfo | null) {
    const audio = announcementCapability(device);
    if (!device || !audio) throw new NotHeard(noSpeaker());
    if (device.availability !== "online") {
      throw new NotHeard(
        toolError("unavailable", `“${device.name}” is offline.`),
      );
    }
    const players = device.capabilities.filter(
      (capability) => capability.kind === "media",
    );
    const playerId = audio.features.announcementPlayer;
    // Older registrations can still identify a sole media player.
    const player = playerId
      ? players.find(({ id }) => id === playerId)
      : players.length === 1
        ? players[0]
        : undefined;
    if (player?.observed?.volume === 0) {
      throw new NotHeard(
        toolError(
          "muted",
          `“${device.name}” is turned all the way down, so nobody would hear it.`,
        ),
      );
    }
    if (player?.observed?.muted === true) {
      throw new NotHeard(
        toolError(
          "muted",
          `“${device.name}” is muted, so nobody would hear it. Someone at home unmutes it.`,
        ),
      );
    }
  }

  const input = z.strictObject({
    speaker: z.string().min(1).max(64),
    text: z.string().trim().min(1).max(maxAnnouncementText),
    language: z.enum(speechLanguages).optional(),
  });

  return {
    tool: () => {
      const homeLanguage = options.language();
      const otherLanguages = speechLanguages
        .filter((language) => language !== homeLanguage)
        .map((language) => languages[language].englishName)
        .join(" or ");
      return {
        name: "announce",
        title: "Announce",
        description: [
          "Say something out loud on one smart speaker, in Sanctum's voice, over whatever it's playing, such as “Dinner's ready” or a reminder someone asked for.",
          `The speakers, by id: ${speakers()
            .map((device) => `${device.id} (${JSON.stringify(device.name)})`)
            .join(", ")}.`,
          `\`text\` is up to ${maxAnnouncementText} characters, said as written in \`language\`: the home's, ${languages[homeLanguage].englishName}${otherLanguages ? `, unless the person speaks ${otherLanguages}` : ""}.`,
          "Each speaker says one thing at a time: what you send while it speaks waits its turn, up to two waiting, and the call answers once it's sent. A few a minute per speaker. A speaker says nothing while offline, muted or turned all the way down.",
          "Announce only what the person asked to have said, and say where it went.",
          notInstructions,
        ].join(" "),
        inputSchema: inputSchemaOf(input),
        annotations: {},
      };
    },
    usable: (canUse: AiCanUse) =>
      isOn(canUse, announcePermission) && speakers().length > 0,
    callable: (canUse) => isOn(canUse, announcePermission),
    refusal: () => areasOff([announcePermission]),
    async run(agent, raw, canUse) {
      if (!isOn(canUse, announcePermission))
        throw areasOff([announcePermission]);
      const parsed = input.safeParse(raw);
      if (!parsed.success) return invalidInput();
      const { speaker: id, text } = parsed.data;
      const language = parsed.data.language ?? options.language();
      const device = options.devices.get(id);
      if (!device) return noSpeaker();
      try {
        heard(device);
      } catch (error) {
        if (error instanceof NotHeard) return error.answer;
        throw error;
      }
      // Hold both quotas before any dispatch can yield to another call.
      const reservations: (() => void)[] = [];
      const hold = (release: () => void) => reservations.push(release);
      const releaseQuota = () => {
        for (const release of reservations) release();
      };
      const wait = Math.max(
        byAgent(agent.id, true, hold) ?? 0,
        bySpeaker(device.id, true, hold) ?? 0,
      );
      if (wait > 0) {
        releaseQuota();
        return toolError(
          "limited",
          `That's enough announcements for now. Try again in ${wait} seconds.`,
        );
      }
      let synthesisStarted = false;
      try {
        const author = options.agentWho(agent.id);
        await options.speech.speak({
          device: device.id,
          text,
          language,
          actor: agent.actor,
          beforeTelling: () => heard(options.devices.get(device.id)),
          onSynthesisStarted: () => {
            synthesisStarted = true;
          },
          onDelivery: (fetched) => {
            options.record({
              action: "device.announce",
              outcome: fetched ? "ok" : "failed",
              ...author,
              subjectId: device.id,
              detail: { text, language },
            });
          },
        });
      } catch (error) {
        if (!synthesisStarted) releaseQuota();
        if (error instanceof NotHeard) return error.answer;
        if (error instanceof SpeechSwitchedOff) {
          throw areasOff([announcePermission]);
        }
        if (error instanceof AnnouncementRefused) {
          return error.reason === "busy"
            ? toolError(
                "busy",
                `“${device.name}” already has two announcements waiting. Try again in a minute.`,
              )
            : toolError(
                "limited",
                "Too many announcements at once. Try again in a minute.",
              );
        }
        if (error instanceof SpeechUnavailable) {
          return toolError("unavailable", error.message);
        }
        return errorAnswer(error);
      }
      return answer({ sentTo: device.name, speaker: device.id });
    },
  };
}
