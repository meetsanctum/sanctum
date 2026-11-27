import {
  moodType,
  type AssistantRequestCall,
  type MoodRun,
  type RequestContext,
  type RequestReply,
} from "@meetsanctum/app-sdk";

import { normalized, type Matched } from "./matching.js";
import type { Replies } from "./replies.js";
import { callTool, type Overview, type ToolFailure } from "./tools.js";

// The home's moods, by the standard mood type whatever app keeps them, as
// the entities tool lists them for AI agents, and running one with the run
// tool. A mood belongs to a room: one named in the request, else the
// speaker's, else the one room that has a mood of that name.

/** A mood as the entities tool gives it: which app keeps it, and its room. */
export type Mood = {
  app: string;
  /** The app's name, as its settings are called. */
  appName: string | null;
  key: string;
  name: string;
  state: { placeId: string };
};

/** The home's moods AI agents may see, or a failure to look them up. */
export async function readMoods(
  ctx: RequestContext,
): Promise<{ ok: true; moods: Mood[] } | ToolFailure> {
  const read = await callTool(ctx, "entities", { type: moodType.id });
  if (!read.ok) {
    // When no app offers readable entities, there are no moods to match.
    return read.error === "not_allowed" ? { ok: true, moods: [] } : read;
  }
  return { ok: true, moods: (read.value as { entities: Mood[] }).entities };
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
  let room = request.from.kind === "speaker" ? request.room : null;
  if (roomName !== undefined) {
    const rooms = overview.rooms.filter((each) => same(each.name, roomName));
    if (rooms.length > 1) return { reply: words.whichNamed("room", roomName) };
    room = rooms[0] ?? null;
  }
  if (room) {
    const here = named.filter((mood) => mood.state.placeId === room.id);
    if (here.length === 1) return { mood: here[0]! };
    if (here.length > 1) return { reply: words.duplicateMood(name, room.name) };
    if (roomName !== undefined) {
      return { reply: words.noSuchMood(name, room.name) };
    }
  }
  if (named.length === 1) return { mood: named[0]! };
  if (named.length === 0) return { reply: words.noSuchMood(name, null) };
  const placeId = named[0]!.state.placeId;
  if (named.every((mood) => mood.state.placeId === placeId)) {
    const place = overview.rooms.find((each) => each.id === placeId);
    return { reply: words.duplicateMood(name, place?.name ?? null) };
  }
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
  if (!ran.ok) {
    return {
      text:
        ran.error === "not_allowed"
          ? words.cannotRunMood(ran.words, mood.appName ?? mood.app)
          : words.failed(ran.words, ran.error),
    };
  }
  const { result } = ran.value as { result: MoodRun };
  const room =
    overview.rooms.find((each) => each.id === mood.state.placeId)?.name ??
    mood.name;
  const changed = result.switched > 0;
  const done = changed ? words.moodSet(mood.name, room) : words.nothingChanged;
  if (result.failed.length === 0) {
    return changed ? { text: done, confirmation: true } : { text: done };
  }
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
