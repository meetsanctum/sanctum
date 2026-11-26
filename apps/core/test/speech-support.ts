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
    transcript?: string;
    trainError?: () => string | undefined;
    answerAfterStopMs?: number;
  } = {},
) {
  const lessons: Record<string, unknown>[] = [];
  const heard: Heard[] = [];
  const server = createServer((socket) => {
    socket.on("error", () => {});
    let buffered = Buffer.alloc(0);
    let bytes = 0;
    let voice = false;
    let answered = false;
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
      send("transcript", { text: options.transcript ?? "" });
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
        if (head.type === "train") {
          const { token, ...lesson } = data;
          const error = options.trainError?.();
          if (token !== (options.token ?? "secret")) {
            send("error", { text: "Training requires a valid token" });
          } else if (error) {
            send("error", { text: error });
          } else {
            lessons.push(lesson);
            send("trained", {
              digest: `digest-${lessons.length}`,
              changed: true,
            });
          }
        }
        if (head.type === "audio-chunk" && !answered) {
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
    url: `tcp://127.0.0.1:${address.port}`,
    port: address.port,
  };
}
