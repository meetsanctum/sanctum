import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { synthesize, SpeechError } from "../src/speech/wyoming.js";

// A fake speech service speaking Wyoming, as Piper does.
function event(type: string, data: object, payload?: Buffer) {
  const dataBytes = Buffer.from(JSON.stringify(data));
  const head = {
    type,
    data_length: dataBytes.length,
    ...(payload ? { payload_length: payload.length } : {}),
  };
  return Buffer.concat([
    Buffer.from(`${JSON.stringify(head)}\n`),
    dataBytes,
    payload ?? Buffer.alloc(0),
  ]);
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function service(answer: (socket: Socket, asked: Record<string, unknown>) => void) {
  const server = createServer((socket) => {
    let line = "";
    socket.on("data", (bytes) => {
      line += bytes.toString();
      const newline = line.indexOf("\n");
      if (newline >= 0) answer(socket, JSON.parse(line.slice(0, newline)) as Record<string, unknown>);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

function pcm(...samples: number[]) {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => bytes.writeInt16LE(sample, i * 2));
  return bytes;
}

async function all(port: number, idleMs = 2_000, signal?: AbortSignal) {
  const got: { rate: number; samples: number[] }[] = [];
  for await (const audio of synthesize({
    host: "127.0.0.1",
    port,
    text: "Dinner is ready.",
    voice: "en_US-norman-medium",
    idleMs,
    signal,
  })) {
    got.push({ rate: audio.rate, samples: Array.from(audio.samples) });
  }
  return got;
}

describe("synthesize", () => {
  it("asks for the words in the voice and yields the audio as it comes", async () => {
    let asked: Record<string, unknown> | null = null;
    const port = await service((socket, request) => {
      asked = request;
      const format = { rate: 22_050, width: 2, channels: 1 };
      // A sample split across two chunks, and a header split across writes.
      const stream = Buffer.concat([
        event("audio-start", format),
        event("audio-chunk", format, pcm(1, -2, 3).subarray(0, 5)),
        event("audio-chunk", format, Buffer.concat([pcm(3).subarray(1), pcm(-4)])),
        event("audio-stop", {}),
      ]);
      socket.write(stream.subarray(0, 10));
      setTimeout(() => socket.write(stream.subarray(10)), 20);
    });
    expect(await all(port)).toEqual([
      { rate: 22_050, samples: [1, -2] },
      { rate: 22_050, samples: [3, -4] },
    ]);
    expect(asked).toEqual({
      type: "synthesize",
      data: { text: "Dinner is ready.", voice: { name: "en_US-norman-medium" } },
    });
  });

  it("passes on the service's error", async () => {
    const port = await service((socket) => {
      socket.write(event("error", { text: "Voice not found" }));
    });
    await expect(all(port)).rejects.toThrow(new SpeechError("Voice not found"));
  });

  it("refuses audio that isn't 16-bit mono", async () => {
    const port = await service((socket) => {
      socket.write(event("audio-start", { rate: 22_050, width: 2, channels: 2 }));
    });
    await expect(all(port)).rejects.toThrow(SpeechError);
  });

  it("gives up on a service that goes quiet, or closes early", async () => {
    const quiet = await service(() => {});
    await expect(all(quiet, 100)).rejects.toThrow("The speech service went quiet");
    const closing = await service((socket) => socket.end());
    await expect(all(closing)).rejects.toThrow("The speech service closed the connection");
  });

  it("stops when it's cancelled", async () => {
    const port = await service(() => {});
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(all(port, 5_000, controller.signal)).rejects.toThrow("Speech was cancelled");
  });

  it("fails on a service that doesn't answer in Wyoming", async () => {
    const port = await service((socket) => socket.write("not json\n"));
    await expect(all(port)).rejects.toThrow(SpeechError);
  });
});
