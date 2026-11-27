import {
  aiAssistantPermission,
  assistantAppId,
  defineAction,
  defineApp,
  requestLanguages,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import { answerRequest } from "./requests.js";
import { notUnderstood, sentences } from "./sentences.js";

// Sanctum's Assistant: the household's one assistant, which answers what
// someone says to a smart speaker or types to Sanctum. It knows its own
// sentences, in English and German, and does what they ask through the
// tools every AI agent gets: lights on, off, brighter, dimmer or to a
// brightness, for the speaker's room, a room, a floor, a light or the whole
// home, and putting back what it changed. It asks no model.

/** Sets the home's one language, which smart speakers hear and speak. */
const language = defineAction({
  id: "assistant.language",
  title: "Language",
  tier: "write",
  input: z.object({ language: z.enum(requestLanguages) }),
  output: z.object({}),
  async run(ctx, input) {
    await ctx.speech.setLanguage(input.language);
    return {};
  },
});

export const app = defineApp({
  id: assistantAppId,
  name: "Assistant",
  version: "0.1.0",
  core: "^2.0.0",
  summary: "Does what you ask your smart speakers or type to Sanctum.",
  icon: { glyph: "message-circle-more", color: "iris" },
  permissions: [
    {
      id: aiAssistantPermission,
      reason: "To do what you ask, with what AI agents may use.",
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
