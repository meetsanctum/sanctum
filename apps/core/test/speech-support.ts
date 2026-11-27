import { createServer } from "node:net";

/** A fake Piper that says one chunk of sound for any words. */
export async function fakePiper(asked: unknown[]) {
  const server = createServer((socket) => {
    // The core hangs up mid-answer when it stops or gives up on a voice.
    socket.on("error", () => {});
    socket.once("data", (bytes) => {
      asked.push(JSON.parse(bytes.toString().split("\n")[0]!));
      const format = { rate: 22_050, width: 2, channels: 1 };
      const event = (type: string, data: object, payload?: Buffer) => {
        const body = Buffer.from(JSON.stringify(data));
        return Buffer.concat([
          Buffer.from(
            `${JSON.stringify({ type, data_length: body.length, ...(payload && { payload_length: payload.length }) })}\n`,
          ),
          body,
          payload ?? Buffer.alloc(0),
        ]);
      };
      socket.write(
        Buffer.concat([
          event("audio-start", format),
          event("audio-chunk", format, Buffer.alloc(2_000)),
          event("audio-stop", {}),
        ]),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Piper did not listen");
  return { server, url: `tcp://127.0.0.1:${address.port}` };
}

type Heard = { type: string; data: Record<string, unknown>; bytes: number };

/**
 * A fake Speech-to-Phrase: it says voice-started once `voiceAfter` bytes of
 * sound have come, answers `transcript` after `endAfter` bytes or at
 * audio-stop, and keeps every lesson it's taught.
 */
export async function fakeSpeechToPhrase(
  options: {
    token?: string;
    voiceAfter?: number | null;
    endAfter?: number | null;
    // The words it hears, or each time what they are now.
    transcript?: string | (() => string);
    trainError?: () => string | undefined;
    beforeTrain?: (
      lesson: Record<string, unknown>,
    ) => Promise<void> | undefined;
    answerAfterStopMs?: number;
  } = {},
) {
  const lessons: Record<string, unknown>[] = [];
  const heard: Heard[] = [];
  let hasLesson = true;
  // The language of the model it has loaded, once it has been taught.
  let loaded: string | null = null;
  const cached = new Set<string>();
  const server = createServer((socket) => {
    socket.on("error", () => {});
    let buffered = Buffer.alloc(0);
    let bytes = 0;
    let voice = false;
    let answered = false;
    let runLanguage: string | null = null;
    const send = (type: string, data: object = {}) => {
      const body = Buffer.from(JSON.stringify(data));
      socket.write(
        Buffer.concat([
          Buffer.from(
            `${JSON.stringify({ type, data_length: body.length })}\n`,
          ),
          body,
        ]),
      );
    };
    const answer = () => {
      if (answered) return;
      answered = true;
      const { transcript } = options;
      send("transcript", {
        text:
          typeof transcript === "function" ? transcript() : (transcript ?? ""),
        ...(runLanguage && { language: runLanguage }),
      });
    };
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const newline = buffered.indexOf(10);
        if (newline < 0) return;
        const head = JSON.parse(buffered.subarray(0, newline).toString()) as {
          type: string;
          data_length?: number;
          payload_length?: number;
        };
        const end =
          newline + 1 + (head.data_length ?? 0) + (head.payload_length ?? 0);
        if (buffered.length < end) return;
        const data = head.data_length
          ? (JSON.parse(
              buffered
                .subarray(newline + 1, newline + 1 + head.data_length)
                .toString(),
            ) as Record<string, unknown>)
          : {};
        const payload = head.payload_length ?? 0;
        buffered = buffered.subarray(end);
        heard.push({ type: head.type, data, bytes: payload });
        if (head.type === "describe") {
          send("info", {
            cached_languages: [...cached],
            asr: [
              {
                models: hasLesson
                  ? [{ name: "test", languages: loaded ? [loaded] : [] }]
                  : [],
              },
            ],
          });
        }
        if (head.type === "train") {
          const { token, ...lesson } = data;
          const error = options.trainError?.();
          if (token !== (options.token ?? "secret")) {
            send("error", { text: "Training requires a valid token" });
          } else if (error) {
            send("error", { text: error });
          } else {
            void Promise.resolve(options.beforeTrain?.(lesson)).then(() => {
              lessons.push(lesson);
              hasLesson = true;
              loaded =
                typeof lesson.language === "string" ? lesson.language : null;
              if (loaded) cached.add(loaded);
              send("trained", {
                digest: `digest-${lessons.length}`,
                changed: true,
              });
            });
          }
        }
        if (head.type === "audio-start") runLanguage = loaded;
        if (head.type === "audio-chunk" && hasLesson && !answered) {
          bytes += payload;
          const voiceAfter =
            options.voiceAfter === undefined ? 3_200 : options.voiceAfter;
          if (!voice && voiceAfter !== null && bytes >= voiceAfter) {
            voice = true;
            send("voice-started");
          }
          const endAfter =
            options.endAfter === undefined ? 9_600 : options.endAfter;
          if (voice && endAfter !== null && bytes >= endAfter) answer();
        }
        if (head.type === "audio-stop") {
          if (options.answerAfterStopMs === undefined) answer();
          else setTimeout(answer, options.answerAfterStopMs).unref();
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Speech-to-Phrase did not listen");
  return {
    server,
    lessons,
    heard,
    forgetLesson() {
      hasLesson = false;
    },
    url: `tcp://127.0.0.1:${address.port}`,
    port: address.port,
  };
}

// Sound as a run has it, in 100 ms chunks, ending with listening: as fast
// as it can come, or as a speaker sends it.
export function speechSound(chunks: number, everyMs = 5) {
  let stopped = false;
  return {
    stopListening: () => {
      stopped = true;
    },
    get stopped() {
      return stopped;
    },
    sound: (async function* () {
      for (let i = 0; i < chunks && !stopped; i += 1) {
        yield Buffer.alloc(3_200);
        await new Promise((resolve) => setTimeout(resolve, everyMs));
      }
    })(),
  };
}
