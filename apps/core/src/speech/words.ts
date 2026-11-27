import { connect } from "node:net";

import {
  listenRate,
  speechLanguages,
  type SpeechLanguage,
} from "@meetsanctum/app-sdk";

import { createReader, SpeechError, type WyomingEvent } from "./wyoming.js";

// Speech to text over Wyoming, as Sanctum's image of Speech-to-Phrase speaks
// it (deploy/speech-to-phrase): `transcribe`, `audio-start`, the sound as
// `audio-chunk` events, and back `voice-started` once speech begins and
// `transcript` once its voice detector hears it end, or after `audio-stop`.
// A `train` event, with the service's token, teaches it a lesson, and it
// answers `trained`.

/** How long a run may go without speech beginning: nobody spoke. */
export const noVoiceMs = 4_000;
/** How long the service may take to answer once the sound has stopped. */
const answerMs = 15_000;
const connectMs = 5_000;
/** How long a lesson may take, a model's first download included. */
export const lessonMs = 15 * 60_000;

/** What speech recognition learns: templates and each blank's names. */
export type Lesson = {
  language: string;
  templates: readonly string[];
  lists: Record<string, readonly string[]>;
};

export class MissingSpeechLesson extends SpeechError {}

export type SpeechTranscript = { text: string; language?: SpeechLanguage };

// One connection to the service: events out, and the next event back
// within a time.
function open(endpoint: { host: string; port: number }, signal?: AbortSignal) {
  const cancelled = new SpeechError("Speech recognition was cancelled");
  if (signal?.aborted) throw cancelled;
  const socket = connect(endpoint);
  const reader = createReader();
  const queue: (Buffer | Error | null)[] = [];
  let wake: (() => void) | null = null;
  const push = (item: Buffer | Error | null) => {
    queue.push(item);
    wake?.();
  };
  socket.on("data", (bytes: Buffer) => push(bytes));
  socket.on("error", (error) => push(error));
  socket.on("close", () => push(null));
  let connecting: ((error?: Error) => void) | undefined;
  const abort = () => {
    connecting?.(cancelled);
    push(cancelled);
    socket.destroy();
  };
  const disconnected = () =>
    connecting?.(new SpeechError("Speech recognition closed the connection"));
  const failed = (error: Error) => connecting?.(new SpeechError(error.message));
  signal?.addEventListener("abort", abort, { once: true });
  const connected = new Promise<void>((resolve, reject) => {
    const ready = () => connecting?.();
    const timer = setTimeout(
      () =>
        connecting?.(
          new SpeechError("Speech recognition didn't connect in time"),
        ),
      connectMs,
    );
    connecting = (error) => {
      connecting = undefined;
      clearTimeout(timer);
      socket.off("connect", ready);
      socket.off("close", disconnected);
      socket.off("error", failed);
      if (error) reject(error);
      else resolve();
    };
    socket.once("connect", ready);
    socket.once("close", disconnected);
    socket.once("error", failed);
  });

  return {
    connected,
    send(type: string, data: object = {}, payload?: Buffer) {
      const body = Buffer.from(JSON.stringify(data));
      const header = {
        type,
        data_length: body.length,
        ...(payload ? { payload_length: payload.length } : {}),
      };
      socket.write(
        Buffer.concat([
          Buffer.from(`${JSON.stringify(header)}\n`),
          body,
          payload ?? Buffer.alloc(0),
        ]),
      );
    },
    /** The next event, null once `ms` pass without one. */
    async next(ms: number): Promise<WyomingEvent | null> {
      let event: WyomingEvent | null;
      while ((event = reader.next()) === null) {
        if (queue.length === 0) {
          let timer: NodeJS.Timeout | undefined;
          const woke = await Promise.race([
            new Promise<"woke">((resolve) => (wake = () => resolve("woke"))),
            new Promise<"timeout">((resolve) => {
              timer = setTimeout(() => resolve("timeout"), ms);
            }),
          ]);
          clearTimeout(timer);
          wake = null;
          if (woke === "timeout") return null;
        }
        const item = queue.shift()!;
        if (item === null) {
          throw new SpeechError("Speech recognition closed the connection");
        }
        if (item instanceof Error) {
          throw item instanceof SpeechError
            ? item
            : new SpeechError(item.message);
        }
        reader.push(item);
      }
      if (event.type === "error") {
        throw new SpeechError(
          typeof event.data.text === "string"
            ? event.data.text
            : "Speech recognition failed",
        );
      }
      return event;
    },
    close() {
      signal?.removeEventListener("abort", abort);
      socket.destroy();
    },
  };
}

/**
 * Hears a run's words: streams its sound and stops listening once the
 * service has the transcript, or when nobody began to speak within
 * `noVoiceMs` of the first sound. Returns null when nobody spoke or a
 * transcript with empty text for speech outside what it learned.
 */
export async function transcribe(options: {
  host: string;
  port: number;
  language: string;
  sound: AsyncIterable<Buffer>;
  stopListening(): void;
  signal: AbortSignal;
}): Promise<SpeechTranscript | null> {
  const connection = open(options, options.signal);
  const format = { rate: listenRate, width: 2, channels: 1 };
  let voice = false;
  let answered = false;
  let firstSound: number | null = null;
  let answerBy: number | null = null;
  try {
    await connection.connected;
    options.signal.throwIfAborted();
    // A restart can leave the service at the same address without its grammar.
    connection.send("describe");
    const info = await connection.next(connectMs);
    const asr = info?.data.asr;
    if (info?.type !== "info" || !Array.isArray(asr)) {
      throw new SpeechError("Speech recognition didn't describe its models");
    }
    if (
      !asr.some(
        (program) =>
          Array.isArray(program?.models) && program.models.length > 0,
      )
    ) {
      throw new MissingSpeechLesson("Speech recognition has no lesson");
    }
    options.signal.throwIfAborted();
    connection.send("transcribe", { language: options.language });
    connection.send("audio-start", format);
    // The service's answers, read while the sound goes out.
    const answer = (async () => {
      for (;;) {
        const now = performance.now();
        if (answerBy !== null && now >= answerBy) {
          throw new SpeechError("Speech recognition didn't answer in time");
        }
        const event = await connection.next(
          answerBy === null
            ? voice || firstSound === null
              ? 1_000
              : 100
            : answerBy - now,
        );
        if (event?.type === "voice-started") voice = true;
        if (event?.type === "transcript") {
          answered = true;
          options.stopListening();
          const text =
            typeof event.data.text === "string" ? event.data.text : "";
          if (!voice && text === "") return null;
          const language = speechLanguages.find(
            (language) => language === event.data.language,
          );
          return { text, ...(language && { language }) };
        }
        if (
          !voice &&
          firstSound !== null &&
          Date.now() - firstSound >= noVoiceMs
        ) {
          options.stopListening();
          return null;
        }
      }
    })();
    const sent = (async () => {
      for await (const chunk of options.sound) {
        if (options.signal.aborted || answered) break;
        firstSound ??= Date.now();
        connection.send("audio-chunk", format, chunk);
      }
      if (!options.signal.aborted && !answered) {
        connection.send("audio-stop");
        answerBy = performance.now() + answerMs;
      }
    })();
    const [transcript] = await Promise.all([answer, sent]);
    return transcript;
  } finally {
    connection.close();
    options.stopListening();
  }
}

/**
 * The languages of the models the service has loaded: the one it was last
 * taught in, since it started.
 */
export async function describeLanguages(options: {
  host: string;
  port: number;
  signal?: AbortSignal;
}): Promise<SpeechLanguage[]> {
  const languagesIn = (value: unknown) =>
    Array.isArray(value)
      ? speechLanguages.filter((language) => value.includes(language))
      : [];
  const connection = open(options, options.signal);
  try {
    await connection.connected;
    connection.send("describe");
    const info = await connection.next(connectMs);
    const asr: unknown = info?.data.asr;
    if (info?.type !== "info" || !Array.isArray(asr)) {
      throw new SpeechError("Speech recognition didn't describe its models");
    }
    return asr.flatMap((program: { models?: unknown }) =>
      Array.isArray(program?.models)
        ? program.models.flatMap((model: { languages?: unknown }) =>
            languagesIn(model?.languages),
          )
        : [],
    );
  } finally {
    connection.close();
  }
}

/**
 * Teaches the service a lesson with its token, and answers once it has it:
 * whether anything changed, and the lesson's digest.
 */
export async function train(options: {
  host: string;
  port: number;
  token: string;
  lesson: Lesson;
  signal?: AbortSignal;
}): Promise<{ digest: string; changed: boolean }> {
  const connection = open(options, options.signal);
  try {
    await connection.connected;
    options.signal?.throwIfAborted();
    connection.send("train", { token: options.token, ...options.lesson });
    for (;;) {
      const event = await connection.next(lessonMs);
      if (!event)
        throw new SpeechError("Speech recognition didn't learn in time");
      if (event.type === "trained") {
        return {
          digest: String(event.data.digest ?? ""),
          changed: event.data.changed === true,
        };
      }
    }
  } finally {
    connection.close();
  }
}
