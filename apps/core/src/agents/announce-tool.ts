import {
  announcePermission,
  type AiCanUse,
  type DeviceInfo,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import type { ActivityAuthor, NewActivityEntry } from "../activity/activity.js";
import { AnnouncementRefused } from "../speech/announcements.js";
import {
  speechLanguages,
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
// at a time, a muted or offline one says nothing, and a few a minute is all
// an agent or a speaker gets, so an agent can't talk over the household.

/** The most an announcement says, in characters. */
export const maxAnnouncementText = 300;

const announceLimits = {
  // Each agent's, and the home's, in the last minute.
  agent: { agentPerMinute: 6, homePerMinute: 20 },
  // Each speaker's, whoever asks.
  speaker: { agentPerMinute: 4, homePerMinute: Number.POSITIVE_INFINITY },
};

export function createAnnounceTool(options: {
  devices: { list(): DeviceInfo[]; get(id: string): DeviceInfo | null };
  speech: Pick<Speech, "speak">;
  record: (entry: NewActivityEntry) => string;
  agentWho: (id: string) => ActivityAuthor;
  now?: () => number;
}): CoreTool {
  const now = options.now ?? (() => performance.now());
  const byAgent = minuteWindows(announceLimits.agent, now);
  const bySpeaker = minuteWindows(announceLimits.speaker, now);

  const announcesOn = (device: DeviceInfo) =>
    device.capabilities.some(
      (capability) =>
        capability.kind === "audio" &&
        (capability.features as { announces?: boolean }).announces === true,
    );
  const speakers = () => options.devices.list().filter(announcesOn);

  const input = z.strictObject({
    speaker: z.string().min(1).max(64),
    text: z.string().trim().min(1).max(maxAnnouncementText),
    language: z.enum(speechLanguages).default("en"),
  });

  // A speaker's mute silences an announcement while it still reports
  // playing it, so a muted one is refused rather than unmuted.
  const isMuted = (device: DeviceInfo) =>
    device.capabilities.some(
      (capability) =>
        capability.kind === "media" &&
        (capability.observed as { muted?: boolean } | null)?.muted === true,
    );

  return {
    tool: () => ({
      name: "announce",
      title: "Announce",
      description: [
        "Say something out loud on one smart speaker, in Sanctum's voice, over whatever it's playing, such as “Dinner's ready” or a reminder someone asked for.",
        `The speakers, by id: ${speakers()
          .map((device) => `${device.id} (${JSON.stringify(device.name)})`)
          .join(", ")}.`,
        `\`text\` is up to ${maxAnnouncementText} characters, said as written in \`language\`, English unless the person speaks German.`,
        "Each speaker says one thing at a time, and a few a minute; a muted or offline speaker says nothing.",
        "Announce only what the person asked to have said, and say where it went.",
        notInstructions,
      ].join(" "),
      inputSchema: inputSchemaOf(input),
      annotations: {},
    }),
    usable: (canUse: AiCanUse) =>
      isOn(canUse, announcePermission) && speakers().length > 0,
    callable: (canUse) => isOn(canUse, announcePermission),
    refusal: () => areasOff([announcePermission]),
    async run(agent, raw, canUse) {
      if (!isOn(canUse, announcePermission))
        throw areasOff([announcePermission]);
      const parsed = input.safeParse(raw);
      if (!parsed.success) return invalidInput();
      const { speaker: id, text, language } = parsed.data;
      const device = options.devices.get(id);
      if (!device || !announcesOn(device)) {
        return toolError(
          "not_found",
          "There's no such smart speaker in the home.",
        );
      }
      if (device.availability !== "online") {
        return toolError("unavailable", `“${device.name}” is offline.`);
      }
      if (isMuted(device)) {
        return toolError(
          "muted",
          `“${device.name}” is muted, so nobody would hear it. Someone at home unmutes it.`,
        );
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
      let encoded: Promise<boolean>;
      try {
        ({ encoded } = await options.speech.speak({
          device: device.id,
          text,
          language,
          actor: agent.actor,
        }));
      } catch (error) {
        releaseQuota();
        if (error instanceof AnnouncementRefused) {
          return error.reason === "busy"
            ? toolError("busy", `“${device.name}” is still saying something.`)
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
      if (!(await encoded)) {
        return toolError(
          "unavailable",
          "The announcement audio couldn't be generated.",
        );
      }
      options.record({
        action: "device.announce",
        outcome: "ok",
        ...options.agentWho(agent.id),
        subjectId: device.id,
        detail: { text, language },
      });
      return answer({ sentTo: device.name, speaker: device.id });
    },
  };
}
