import {
  aiAssistantPermission,
  assistantAppId,
  defineAction,
  defineApp,
  placesReadPermission,
  readPermission,
  speechLanguages,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import { answerRequest } from "./requests.js";
import { notUnderstood, sentences } from "./sentences.js";

// Sanctum's Assistant: the household's one assistant, which answers what
// someone says to a smart speaker or types to Sanctum. It knows its own
// sentences, in English and German, and does what they ask through the
// tools every AI agent gets: lights on, off, brighter, dimmer or to a
// brightness, for the speaker's room, a room, a floor, a light or the whole
// home; a room's mood by its name; and putting back a direct light change
// when no mood has run since. It asks no model. Its page is in ./ui.

/** Sets the home's one language, which smart speakers hear and speak. */
const language = defineAction({
  id: "assistant.language",
  title: "Language",
  tier: "write",
  input: z.object({ language: z.enum(speechLanguages) }),
  output: z.object({}),
  async run(ctx, input) {
    await ctx.speech.setLanguage(input.language);
    return {};
  },
});

export const app = defineApp({
  id: assistantAppId,
  name: "Assistant",
  // 0.2.0: its page, which lists the smart speakers by room.
  // 0.2.1: optional choices in sentences as speech recognition reads them.
  // 0.3.0: a room's mood, by its name.
  // 0.3.1: lights a brightness leaves off are not said to be missed.
  version: "0.3.1",
  core: "^2.0.0",
  summary: "Controls lights by voice or typed request.",
  icon: { glyph: "message-circle-more", color: "iris" },
  pages: ["main", "setup"],
  permissions: [
    {
      id: aiAssistantPermission,
      reason: "To control your lights when you ask.",
      needed: true,
    },
    {
      id: readPermission("audio"),
      reason: "To list your smart speakers on its page.",
      needed: true,
    },
    {
      id: placesReadPermission,
      reason: "To show which room each smart speaker is in.",
      needed: true,
    },
  ],
  actions: [language],
  events: [],
  sentences,
  notUnderstood,
  async requests(ctx, request) {
    const reply = await answerRequest(ctx, request);
    if (!request.signal.aborted) await request.reply(reply);
  },
});

export default app;
