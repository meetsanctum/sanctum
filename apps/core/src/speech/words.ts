import { connect } from "node:net";

import { listenRate } from "@meetsanctum/app-sdk";

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
/** How long a lesson may take, a model's first download included. */
export const lessonMs = 15 * 60_000;

/** What speech recognition learns: templates and each blank's names. */
export type Lesson = {
  language: string;
  templates: readonly string[];
  lists: Record<string, readonly string[]>;
};

// One connection to the service: events out, and the next event back
// within a time.
function open(endpoint: { host: string; port: number }, signal?: AbortSignal) {
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
  const abort = () => push(new SpeechError("Speech recognition was cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  const connected = new Promise<void>((resolve) =>
    socket.once("connect", () => resolve()),
  );

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
 * `noVoiceMs` of the first sound. Answers null when nobody spoke, "" for
 * speech outside what it learned, or the words.
 */
export async function transcribe(options: {
  host: string;
  port: number;
  language: string;
  sound: AsyncIterable<Buffer>;
  stopListening(): void;
  signal: AbortSignal;
}): Promise<string | null> {
  const connection = open(options, options.signal);
  const format = { rate: listenRate, width: 2, channels: 1 };
  let voice = false;
  let transcript: string | null = null;
  let firstSound: number | null = null;
  let streaming = true;
  try {
    await connection.connected;
    connection.send("transcribe", { language: options.language });
    connection.send("audio-start", format);
    // The service's answers, read while the sound goes out.
    const answer = (async () => {
      for (;;) {
        const event = await connection.next(
          !streaming ? answerMs : voice || firstSound === null ? 1_000 : 100,
        );
        if (event?.type === "voice-started") voice = true;
        if (event?.type === "transcript") {
          transcript =
            typeof event.data.text === "string" ? event.data.text : "";
          options.stopListening();
          return;
        }
        if (!event && !streaming) {
          throw new SpeechError("Speech recognition didn't answer in time");
        }
        if (
          !voice &&
          firstSound !== null &&
          Date.now() - firstSound >= noVoiceMs
        ) {
          options.stopListening();
          return;
        }
      }
    })();
    const sent = (async () => {
      for await (const chunk of options.sound) {
        if (transcript !== null) break;
        firstSound ??= Date.now();
        connection.send("audio-chunk", format, chunk);
      }
      streaming = false;
      if (transcript === null) connection.send("audio-stop");
    })();
    await Promise.all([answer, sent]);
    if (transcript === null || (!voice && transcript === "")) return null;
    return transcript;
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
