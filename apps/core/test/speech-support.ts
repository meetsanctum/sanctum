import { createServer } from "node:net";

/** A fake Piper that says one chunk of sound for any words. */
export async function fakePiper(asked: unknown[]) {
  const server = createServer((socket) => {
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
