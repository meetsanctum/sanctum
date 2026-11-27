import {
  moodType,
  type AssistantRequestCall,
  type MoodRun,
  type RequestContext,
  type RequestReply,
} from "@meetsanctum/app-sdk";

import { normalized, type Matched } from "./matching.js";
import type { Replies } from "./replies.js";
import { callTool, type Overview } from "./tools.js";

// The home's moods, by the standard mood type whatever app keeps them, as
// the entities tool lists them for AI agents, and running one with the run
// tool. A mood belongs to a room: one named in the request, else the
// speaker's, else the one room that has a mood of that name.

/** A mood as the entities tool gives it: which app keeps it, and its room. */
export type Mood = {
  app: string;
  key: string;
  name: string;
  state: { placeId: string };
};

/** The home's moods AI agents may see, or none when it can't read them. */
export async function readMoods(ctx: RequestContext): Promise<Mood[]> {
  const read = await callTool(ctx, "entities", { type: moodType.id });
  if (!read.ok) return [];
  return (read.value as { entities: Mood[] }).entities;
}

const same = (a: string, b: string) => normalized(a) === normalized(b);

// The mood the request means, or why there is none.
function chosen(
  matched: Matched,
  moods: readonly Mood[],
  overview: Overview,
  request: AssistantRequestCall,
  words: Replies,
): { mood: Mood } | { reply: string } {
  const name = matched.names.mood ?? "";
  const named = moods.filter((mood) => same(mood.name, name));
  const roomName = matched.names.room;
  const room =
    roomName === undefined
      ? request.from.kind === "speaker"
        ? request.room
        : null
      : (overview.rooms.find((each) => same(each.name, roomName)) ?? null);
  if (room) {
    const here = named.filter((mood) => mood.state.placeId === room.id);
    if (here.length > 0) return { mood: here[0]! };
    // A room said out loud has none; the speaker's room may simply not be it.
    if (roomName !== undefined || named.length !== 1) {
      return { reply: words.noSuchMood(name, room.name) };
    }
  }
  if (named.length === 1) return { mood: named[0]! };
  if (named.length === 0) return { reply: words.noSuchMood(name, null) };
  return { reply: words.whichMoodRoom(name) };
}

/** Runs the mood a request names, and says what it did. */
export async function runMood(
  ctx: RequestContext,
  matched: Matched,
  moods: readonly Mood[],
  overview: Overview,
  request: AssistantRequestCall,
  words: Replies,
): Promise<RequestReply> {
  const choice = chosen(matched, moods, overview, request, words);
  if ("reply" in choice) return { text: choice.reply };
  const { mood } = choice;
  const ran = await callTool(ctx, "run", { app: mood.app, key: mood.key });
  if (!ran.ok) return { text: words.cannotRunMood(ran.words) };
  const { result } = ran.value as { result: MoodRun };
  const room =
    overview.rooms.find((each) => each.id === mood.state.placeId)?.name ??
    mood.name;
  const done = words.moodSet(mood.name, room);
  if (result.failed.length === 0) return { text: done, confirmation: true };
  // The lights that didn't answer, by name where the home has them.
  const missed = [
    ...new Set(
      result.failed.map(
        ({ device }) =>
          overview.devices.find((each) => each.id === device)?.name ?? device,
      ),
    ),
  ];
  return { text: words.missedLights(done, missed, true) };
}
