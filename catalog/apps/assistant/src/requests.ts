import {
  controlPermission,
  isActionError,
  permissionWords,
  type AssistantRequestCall,
  type RequestContext,
  type RequestReply,
} from "@meetsanctum/app-sdk";

import { match, normalized, type HomeNames, type Matched } from "./matching.js";
import {
  replies,
  type LightsState,
  type Replies,
  type Subject,
} from "./replies.js";
import { readMoods, runMood } from "./moods.js";
import { languages } from "./sentences.js";
import { agentsPage, callTool, type Overview } from "./tools.js";

// Answers a request: matches its words against the sentences with the
// home's names, then does what it asks through the tools every AI agent
// gets, so it can do only what the household lets AI agents do. It asks no
// model: words outside the sentences get the words that say what it can do.

const lightControlTitle = permissionWords(controlPermission("light")).title;

// One light in a command or restore result.
type LightAnswer = { name: string; result: string; why?: string };
type RestoreAnswer = Omit<LightAnswer, "name">;

type Place =
  | { kind: "room" | "floor"; id: string }
  | { kind: "home" }
  | { kind: "lights"; lights: { device: string; capability: string }[] };

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

type Target = { place: Place; subject: Subject } | { reply: string };

function targetOf(
  matched: Matched,
  where: Exclude<
    Matched["intent"],
    { do: "restore" | "timer" | "mood" }
  >["where"],
  overview: Overview,
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
  if (name === undefined) return null;
  const said = normalized(name);
  if (where === "room" || where === "floor") {
    const places = (where === "room" ? overview.rooms : overview.floors).filter(
      (place) => normalized(place.name) === said,
    );
    if (places.length > 1) return { reply: words.whichNamed(where, name) };
    const [found] = places;
    if (!found) return null;
    return {
      place: { kind: where, id: found.id },
      subject: { kind: "place", name: found.name },
    };
  }
  if (where === "light") {
    let devices = overview.devices.filter(
      (device) =>
        normalized(device.name) === said && lightsOf(device).length > 0,
    );
    const room = request.room;
    if (devices.length > 1 && room) {
      const nearby = devices.filter((device) => device.roomId === room.id);
      if (nearby.length === 1) devices = nearby;
    }
    if (devices.length > 1) return { reply: words.whichNamed(where, name) };
    const [device] = devices;
    if (!device) return null;
    const lights = lightsOf(device).map((capability) => ({
      device: device.id,
      capability: capability.id,
    }));
    return {
      place: { kind: "lights", lights },
      subject: { kind: "light", name: device.name },
    };
  }
  return null;
}

const done = (light: RestoreAnswer) =>
  light.result === "sent" || light.result === "confirmed";
const already = (light: LightAnswer) =>
  light.result === "skipped" && light.why === "already";
const offline = (light: LightAnswer) => light.result === "offline";
const off = (light: LightAnswer) =>
  light.result === "skipped" && light.why === "off";

// What the lights tool did, in a reply.
function lightsReply(
  lights: LightAnswer[],
  subject: Subject,
  state: LightsState,
  words: Replies,
): RequestReply {
  if (lights.length === 0) return { text: words.noLights(subject) };
  if (lights.every(offline)) {
    return { text: words.notAnswering(subject) };
  }
  if (lights.every(already)) {
    return { text: words.already(subject, state) };
  }
  if (lights.every(off)) {
    return { text: words.allOff(subject) };
  }
  const changed = lights.some(done);
  const missed = lights.filter((light) => !done(light) && !already(light));
  if (missed.length === 0) {
    return { text: words.changed(subject, state), confirmation: true };
  }
  if (!changed && missed.every(off)) {
    return { text: words.nothingChanged };
  }
  return {
    text: words.missedLights(
      changed ? words.changed(subject, state) : words.nothingChanged,
      missed.map((light) => light.name),
      missed.every(offline),
    ),
  };
}

async function changeLights(
  ctx: RequestContext,
  matched: Matched,
  overview: Overview,
  request: AssistantRequestCall,
  words: Replies,
): Promise<RequestReply> {
  const { intent } = matched;
  if (
    intent.do === "restore" ||
    intent.do === "timer" ||
    intent.do === "mood"
  ) {
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
  if (!answer.ok) {
    return {
      text:
        answer.error === "mood_not_restorable"
          ? words.cannotUndoMood
          : words.failed(answer.words),
    };
  }
  const { changed } = answer.value as { changed: RestoreAnswer[] };
  if (changed.length === 0) return { text: words.cannotPutBack };
  const missed = changed.filter((light) => !done(light));
  if (missed.length === 0) return { text: words.putBack, confirmation: true };
  const restored = missed.length < changed.length;
  if (!restored && missed.every(({ result }) => result === "changed")) {
    return { text: words.changedSince };
  }
  const issues = new Set(
    missed.map(({ result, why }) => {
      if (why === "limited") return "limited";
      if (
        result === "changed" ||
        result === "offline" ||
        result === "uncertain"
      ) {
        return result;
      }
      return "failed";
    }),
  );
  return {
    text: [
      restored ? words.somePutBack : words.nothingPutBack,
      ...Array.from(issues, (issue) => words.restoreIssues[issue]),
    ].join(" "),
  };
}

/** What the Assistant answers a request, in the request's language. */
export async function answerRequest(
  ctx: RequestContext,
  request: AssistantRequestCall,
): Promise<RequestReply> {
  const language = languages[request.language];
  const words = replies[request.language];
  try {
    // Undo and timer requests don't need the home's names. Lighting phrases
    // can name a device even when they also match a room or whole-home phrase.
    const none: HomeNames = { room: [], floor: [], light: [], mood: [] };
    const unnamed = match(request.text, language, none);
    if (unnamed?.intent.do === "timer") return { text: words.noTimers };
    if (unnamed?.intent.do === "restore") return await putBack(ctx, words);

    const read = await callTool(ctx, "home_overview", {});
    if (!read.ok) return { text: words.failed(read.words) };
    const overview = read.value as Overview;
    const names = namesOf(overview);
    const matched = match(request.text, language, names);
    if (matched)
      return await changeLights(ctx, matched, overview, request, words);

    // A mood's name only after nothing else matched: its list is a read of
    // its own, which lights don't wait for.
    const lookedUp = await readMoods(ctx);
    if (!lookedUp.ok) {
      return { text: words.failed(lookedUp.words, lookedUp.error) };
    }
    const { moods } = lookedUp;
    const named = match(request.text, language, {
      ...names,
      mood: moods.map((mood) => mood.name),
    });
    if (named?.intent.do === "mood") {
      return await runMood(ctx, named, moods, overview, request, words);
    }
    const lightsHidden = overview.notAllowed.some(
      ({ title, where }) => title === lightControlTitle && where === agentsPage,
    );
    return { text: lightsHidden ? words.notAllowed : language.notUnderstood };
  } catch (error) {
    if (isActionError(error) && error.code === "forbidden") {
      return { text: words.notAllowed };
    }
    throw error;
  }
}
