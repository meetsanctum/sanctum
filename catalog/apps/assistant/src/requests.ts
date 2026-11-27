import {
  isActionError,
  type AssistantRequestCall,
  type RequestContext,
  type RequestReply,
} from "@meetsanctum/app-sdk";

import { match, type HomeNames, type Matched } from "./matching.js";
import {
  replies,
  type LightsState,
  type Replies,
  type Subject,
} from "./replies.js";
import { languages } from "./sentences.js";

// Answers a request: matches its words against the sentences with the
// home's names, then does what it asks through the tools every AI agent
// gets, so it can do only what the household lets AI agents do. It asks no
// model: words outside the sentences get the words that say what it can do.

// What home_overview answers that the Assistant reads.
type Overview = {
  floors: { id: string; name: string }[];
  rooms: { id: string; name: string }[];
  devices: {
    id: string;
    name: string;
    capabilities: { id: string; kind: string }[];
  }[];
};

// One light in the lights tool's answer.
type LightAnswer = { name: string; result: string; why?: string };

type Place =
  | { kind: "room" | "floor"; id: string }
  | { kind: "home" }
  | { kind: "lights"; lights: { device: string; capability: string }[] };

// A tool's answer, read: its JSON, or its words when it refused.
type ToolResult = { ok: true; value: unknown } | { ok: false; words: string };

async function callTool(
  ctx: RequestContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const answer = await ctx.ai.call(name, input);
  if (answer.isError) {
    try {
      // A partly limited answer still lists its lights.
      const value = JSON.parse(answer.text) as unknown;
      if (value && typeof value === "object" && "lights" in value) {
        return { ok: true, value };
      }
    } catch {
      // A refusal is one sentence, not JSON.
    }
    return { ok: false, words: answer.text };
  }
  return { ok: true, value: JSON.parse(answer.text) as unknown };
}

const lightsOf = (device: Overview["devices"][number]) =>
  device.capabilities.filter((capability) => capability.kind === "light");

function namesOf(overview: Overview): HomeNames {
  return {
    room: overview.rooms.map((room) => room.name),
    floor: overview.floors.map((floor) => floor.name),
    light: overview.devices
      .filter((device) => lightsOf(device).length > 0)
      .map((device) => device.name),
    // No mood is a name the Assistant knows.
    mood: [],
  };
}

const same = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

type Target = { place: Place; subject: Subject } | { reply: string };

function targetOf(
  matched: Matched,
  where: Exclude<Matched["intent"], { do: "restore" | "timer" }>["where"],
  overview: Overview | undefined,
  request: AssistantRequestCall,
  words: Replies,
): Target | null {
  if (where === "home") {
    return { place: { kind: "home" }, subject: { kind: "home" } };
  }
  if (where === "here") {
    if (request.from.kind === "client") return { reply: words.whichRoom };
    if (!request.room) return { reply: words.notInARoom };
    return {
      place: { kind: "room", id: request.room.id },
      subject: { kind: "place", name: request.room.name },
    };
  }
  const name = matched.names[where];
  if (name === undefined || !overview) return null;
  if (where === "room" || where === "floor") {
    const found = (where === "room" ? overview.rooms : overview.floors).find(
      (place) => same(place.name, name),
    );
    if (!found) return null;
    return {
      place: { kind: where, id: found.id },
      subject: { kind: "place", name: found.name },
    };
  }
  if (where === "light") {
    const lights = overview.devices
      .filter((device) => same(device.name, name))
      .flatMap((device) =>
        lightsOf(device).map((capability) => ({
          device: device.id,
          capability: capability.id,
        })),
      );
    if (lights.length === 0) return null;
    return {
      place: { kind: "lights", lights },
      subject: { kind: "light", name },
    };
  }
  return null;
}

const done = (light: LightAnswer) =>
  light.result === "sent" || light.result === "confirmed";
const notAnswering = (light: LightAnswer) =>
  light.result === "offline" || light.result === "failed";

// What the lights tool did, in a reply.
function lightsReply(
  lights: LightAnswer[],
  subject: Subject,
  state: LightsState,
  words: Replies,
): RequestReply {
  if (lights.length === 0) return { text: words.noLights(subject) };
  const missing = lights.filter(notAnswering).map((light) => light.name);
  if (lights.some(done)) {
    const changed = words.changed(subject, state);
    return missing.length > 0
      ? { text: `${changed} ${words.didNotAnswer(missing)}` }
      : { text: changed, confirmation: true };
  }
  if (missing.length === lights.length) {
    return { text: words.notAnswering(subject) };
  }
  const skipped = lights.filter((light) => !notAnswering(light));
  if (skipped.every((light) => light.why === "already")) {
    return { text: words.already(subject, state) };
  }
  if (
    skipped.every((light) => light.why === "off" || light.why === "already")
  ) {
    return { text: words.allOff(subject) };
  }
  return { text: words.nothingChanged };
}

async function changeLights(
  ctx: RequestContext,
  matched: Matched,
  overview: Overview | undefined,
  request: AssistantRequestCall,
  words: Replies,
): Promise<RequestReply> {
  const { intent } = matched;
  if (intent.do === "restore" || intent.do === "timer") {
    throw new Error("Not a change of lights");
  }
  const target = targetOf(matched, intent.where, overview, request, words);
  if (!target) return { text: languages[request.language].notUnderstood };
  if ("reply" in target) return { text: target.reply };

  let input: Record<string, unknown>;
  let state: LightsState;
  if (intent.do === "set") {
    const percent = matched.choices.percent;
    if (percent === undefined) {
      return { text: languages[request.language].notUnderstood };
    }
    input = { place: target.place, set: { brightness: percent } };
    state = { is: "at", percent };
  } else {
    const to =
      intent.do === "switch"
        ? matched.choices.switch
        : (intent.to ?? matched.choices.step);
    if (to === undefined) {
      return { text: languages[request.language].notUnderstood };
    }
    input = { place: target.place, to };
    state = { is: to };
  }
  const answer = await callTool(ctx, "lights", input);
  if (!answer.ok) return { text: words.failed(answer.words) };
  const { lights } = answer.value as { lights: LightAnswer[] };
  return lightsReply(lights, target.subject, state, words);
}

async function putBack(
  ctx: RequestContext,
  words: Replies,
): Promise<RequestReply> {
  const answer = await callTool(ctx, "restore", {});
  if (!answer.ok) return { text: words.cannotPutBack };
  const { changed } = answer.value as { changed: { result: string }[] };
  return changed.some(
    ({ result }) => result === "sent" || result === "confirmed",
  )
    ? { text: words.putBack, confirmation: true }
    : { text: words.changedSince };
}

/** What the Assistant answers a request, in the request's language. */
export async function answerRequest(
  ctx: RequestContext,
  request: AssistantRequestCall,
): Promise<RequestReply> {
  const language = languages[request.language];
  const words = replies[request.language];
  try {
    // A sentence without a blank, such as "lights off" or "put it back",
    // matches without the home's names, which saves asking for them.
    const none: HomeNames = { room: [], floor: [], light: [], mood: [] };
    let overview: Overview | undefined;
    let matched = match(request.text, language, none);
    if (!matched) {
      const read = await callTool(ctx, "home_overview", {});
      if (!read.ok) return { text: words.failed(read.words) };
      overview = read.value as Overview;
      matched = match(request.text, language, namesOf(overview));
    }
    if (!matched) return { text: language.notUnderstood };
    switch (matched.intent.do) {
      case "timer":
        return { text: words.noTimers };
      case "restore":
        return await putBack(ctx, words);
      default:
        return await changeLights(ctx, matched, overview, request, words);
    }
  } catch (error) {
    if (isActionError(error) && error.code === "forbidden") {
      return { text: words.notAllowed };
    }
    throw error;
  }
}
