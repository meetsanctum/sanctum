import { connect } from "node:net";

// The Wyoming protocol, as the speech services speak it over TCP: each event
// is a line of JSON, then the bytes its `data_length` and `payload_length`
// name. Text to speech sends `synthesize` and gets `audio-start`, a run of
// `audio-chunk` events with PCM in their payloads, then `audio-stop`. Piper
// sends a sentence's audio as soon as it's made, so the first sound comes
// long before the last.

/** The PCM a speech service makes: 16-bit mono at `rate`. */
export type SpeechAudio = { rate: number; samples: Int16Array };

export class SpeechError extends Error {}

/** The longest header line or data block a service may send. */
const maxHeaderBytes = 64 * 1024;
/** The most audio one answer may hold, in bytes (about 5 minutes). */
const maxAudioBytes = 16 * 1024 * 1024;

type Event = { type: string; data: Record<string, unknown>; payload: Buffer };

function parsed(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SpeechError("A speech event doesn't read as Wyoming");
  }
}

/** Reads Wyoming events from a socket's bytes as they come. */
function createReader() {
  let buffered: Buffer = Buffer.alloc(0);
  return {
    push(bytes: Buffer) {
      buffered = buffered.length ? Buffer.concat([buffered, bytes]) : bytes;
    },
    next(): Event | null {
      const newline = buffered.indexOf(10);
      if (newline < 0) {
        if (buffered.length > maxHeaderBytes) {
          throw new SpeechError("A speech event's header is too long");
        }
        return null;
      }
      const head = parsed(buffered.subarray(0, newline)) as {
        type?: unknown;
        data?: unknown;
        data_length?: unknown;
        payload_length?: unknown;
      };
      const dataLength = Number(head.data_length ?? 0);
      const payloadLength = Number(head.payload_length ?? 0);
      if (
        typeof head.type !== "string" ||
        !Number.isInteger(dataLength) ||
        !Number.isInteger(payloadLength) ||
        dataLength < 0 ||
        payloadLength < 0 ||
        dataLength > maxHeaderBytes ||
        payloadLength > maxAudioBytes
      ) {
        throw new SpeechError("A speech event doesn't read as Wyoming");
      }
      const end = newline + 1 + dataLength + payloadLength;
      if (buffered.length < end) return null;
      const data = {
        ...(typeof head.data === "object" && head.data ? head.data : {}),
        ...(dataLength
          ? (parsed(buffered.subarray(newline + 1, newline + 1 + dataLength)) as Record<
              string,
              unknown
            >)
          : {}),
      } as Record<string, unknown>;
      const payload = Buffer.from(buffered.subarray(newline + 1 + dataLength, end));
      buffered = buffered.subarray(end);
      return { type: head.type, data, payload };
    },
  };
}

/**
 * Asks the speech service at `host:port` to say `text` in `voice` and
 * yields its audio as it comes. Ends when the service says the audio is
 * done; throws if it fails, goes quiet for `idleMs`, or `signal` aborts.
 */
export async function* synthesize(options: {
  host: string;
  port: number;
  text: string;
  voice: string;
  idleMs: number;
  signal?: AbortSignal;
}): AsyncGenerator<SpeechAudio> {
  const socket = connect({ host: options.host, port: options.port });
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
  const abort = () => push(new SpeechError("Speech was cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  socket.on("connect", () => {
    socket.write(
      `${JSON.stringify({
        type: "synthesize",
        data: { text: options.text, voice: { name: options.voice } },
      })}\n`,
    );
  });

  let rate = 0;
  let width = 0;
  let channels = 0;
  let total = 0;
  // A sample split across two chunks waits for its second byte.
  let carry: Buffer | null = null;
  try {
    for (;;) {
      let event: Event | null;
      while ((event = reader.next()) === null) {
        if (queue.length === 0) {
          const quiet = new Promise<void>((resolve) => {
            wake = resolve;
          });
          let timer: NodeJS.Timeout | undefined;
          const timedOut = new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), options.idleMs);
          });
          const woke = await Promise.race([quiet, timedOut]);
          clearTimeout(timer);
          wake = null;
          if (woke === "timeout") throw new SpeechError("The speech service went quiet");
        }
        const item = queue.shift()!;
        if (item === null) throw new SpeechError("The speech service closed the connection");
        if (item instanceof Error) {
          throw item instanceof SpeechError ? item : new SpeechError(item.message);
        }
        reader.push(item);
      }
      if (event.type === "error") {
        throw new SpeechError(
          typeof event.data.text === "string" ? event.data.text : "The speech service failed",
        );
      }
      if (event.type === "audio-start" || event.type === "audio-chunk") {
        rate = Number(event.data.rate ?? rate);
        width = Number(event.data.width ?? width);
        channels = Number(event.data.channels ?? channels);
        if (width !== 2 || channels !== 1 || !(rate >= 8_000 && rate <= 48_000)) {
          throw new SpeechError("The speech service sent audio in a format Sanctum can't play");
        }
      }
      if (event.type === "audio-chunk" && event.payload.length > 0) {
        total += event.payload.length;
        if (total > maxAudioBytes) throw new SpeechError("The speech is too long");
        let bytes: Buffer = carry ? Buffer.concat([carry, event.payload]) : event.payload;
        carry = null;
        if (bytes.length % 2 === 1) {
          carry = bytes.subarray(bytes.length - 1);
          bytes = bytes.subarray(0, bytes.length - 1);
        }
        const samples = new Int16Array(bytes.length / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2);
        yield { rate, samples };
      }
      if (event.type === "audio-stop") return;
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    socket.destroy();
  }
}
