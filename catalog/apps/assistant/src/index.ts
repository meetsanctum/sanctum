import {
  aiAssistantPermission,
  assistantAppId,
  defineApp,
  placesReadPermission,
  readPermission,
} from "@meetsanctum/app-sdk";
import { answerRequest } from "./requests.js";
import { notUnderstood, sentences } from "./sentences.js";

// Sanctum's Assistant: the household's one assistant, which answers what
// someone says to a smart speaker or types to Sanctum. It knows its own
// sentences, in English and German, and does what they ask through the
// tools every AI agent gets: lights on, off, brighter, dimmer, to a
// brightness, a white or a colour, for the speaker's room, a room, a floor,
// a light or the whole home; a room's mood by its name; and putting back a
// direct light change when no mood has run since. It asks no model. Its
// page is in ./ui.

export const app = defineApp({
  id: assistantAppId,
  name: "Assistant",
  // 0.2.0: its page, which lists the smart speakers by room.
  // 0.2.1: optional choices in sentences as speech recognition reads them.
  // 0.3.0: a room's mood, by its name.
  // 0.3.1: lights a brightness leaves off are not said to be missed.
  // 0.3.2: lights a room's rule keeps off are not said to be missed.
  // 0.4.0: no language of its own: Household sets the home's, and its page
  // shows it and links there.
  // 0.5.0: whites and colours, as a room's Lights tile sets them.
  version: "0.5.0",
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
  actions: [],
  events: [],
  sentences,
  notUnderstood,
  async requests(ctx, request) {
    const reply = await answerRequest(ctx, request);
    if (!request.signal.aborted) await request.reply(reply);
  },
});

export default app;
