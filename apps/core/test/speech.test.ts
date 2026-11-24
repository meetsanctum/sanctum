import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  createAnnouncements,
  type Announcements,
} from "../src/speech/announcements.js";
import {
  createSpeech,
  SpeechUnavailable,
  voices,
} from "../src/speech/speech.js";

// Speech: Piper runs while a smart speaker can announce and AI agents may
// speak on them, and what's said goes to the speaker as an address.

const speaker = (id: string, announces: boolean) =>
  ({
    id,
    name: "Office Speaker",
    availability: "online",
    capabilities: [
      {
        id: "audio",
        kind: "audio",
        features: { mutes: true, muteSwitch: true, announces },
      },
    ],
  }) as unknown as DeviceInfo;

let announcements: Announcements | undefined;
let piper: Server | undefined;
afterEach(async () => {
  await announcements?.stop();
  piper?.close();
  announcements = undefined;
  piper = undefined;
});

/** A fake Piper that says one chunk of sound for any words. */
async function fakePiper(asked: unknown[]) {
  piper = createServer((socket) => {
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
  await new Promise<void>((resolve) => piper!.listen(0, "127.0.0.1", resolve));
  const address = piper.address();
  return `tcp://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

function setup(options: {
  devices: DeviceInfo[];
  areaOn?: boolean;
  serviceUrl?: string | null;
  address?: string | null;
}) {
  const calls: string[] = [];
  const told: { device: string; url: string }[] = [];
  let areaOn = options.areaOn ?? true;
  announcements = createAnnouncements({
    host: "127.0.0.1",
    port: 0,
    log: () => {},
  });
  const speech = createSpeech({
    announcements,
    manager: {
      serviceUrl: async () => options.serviceUrl ?? null,
      hostStatus: async () => ({
        network:
          options.address === null
            ? null
            : { address: options.address ?? "192.168.1.20" },
      }),
      wantServiceForCore: async (service) => void calls.push(`want ${service}`),
      releaseServiceForCore: async (service) =>
        void calls.push(`release ${service}`),
    },
    devices: {
      list: () => options.devices,
      announce: async (device, url) => void told.push({ device, url }),
    },
    areaOn: () => areaOn,
    publishedPort: 4180,
    log: () => {},
  });
  return {
    speech,
    calls,
    told,
    setArea(on: boolean) {
      areaOn = on;
      speech.areaChanged();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("createSpeech", () => {
  it("wants Piper while a speaker announces and the area is on, and lets it go after", async () => {
    const { speech, calls, setArea } = setup({ devices: [speaker("a", true)] });
    speech.start();
    await settle();
    expect(calls).toEqual(["want piper"]);

    setArea(false);
    await settle();
    expect(calls).toEqual(["want piper", "release piper"]);
    setArea(true);
    await settle();
    // The speaker goes: nothing left to say things on.
    speech.deviceChanged({ id: "a", before: speaker("a", true), after: null });
    await settle();
    expect(calls).toEqual([
      "want piper",
      "release piper",
      "want piper",
      "release piper",
    ]);
    speech.stop();
  });

  it("doesn't want Piper in a home with no speaker that announces", async () => {
    const { speech, calls } = setup({ devices: [speaker("a", false)] });
    speech.start();
    await settle();
    expect(calls).toEqual(["release piper"]);
    speech.deviceChanged({
      id: "a",
      before: speaker("a", false),
      after: speaker("a", false),
    });
    await settle();
    expect(calls).toEqual(["release piper"]);
    speech.stop();
  });

  it("says the words in the language's voice and tells the speaker its address", async () => {
    const asked: unknown[] = [];
    const url = await fakePiper(asked);
    const { speech, told } = setup({
      devices: [speaker("a", true)],
      serviceUrl: url,
    });
    await announcements!.start();
    const said = await speech.speak({
      device: "a",
      text: "Das Essen ist fertig.",
      language: "de",
      actor: { kind: "app", id: "sanctum.example" },
    });
    expect(await said.spoken).toBe(true);
    expect(told).toHaveLength(1);
    expect(told[0]!.url).toMatch(
      /^http:\/\/192\.168\.1\.20:4180\/a\/.+\.flac$/,
    );
    expect(asked.at(-1)).toEqual({
      type: "synthesize",
      data: { text: "Das Essen ist fertig.", voice: { name: voices.de } },
    });
    speech.stop();
  });

  it("is unavailable while Piper isn't running or the host's address is unknown", async () => {
    const actor = { kind: "app", id: "sanctum.example" } as const;
    const stopped = setup({ devices: [speaker("a", true)], serviceUrl: null });
    await expect(
      stopped.speech.speak({ device: "a", text: "Hi", language: "en", actor }),
    ).rejects.toThrow(SpeechUnavailable);
    await announcements!.stop();
    const nowhere = setup({
      devices: [speaker("a", true)],
      serviceUrl: "tcp://127.0.0.1:1",
      address: null,
    });
    await expect(
      nowhere.speech.speak({ device: "a", text: "Hi", language: "en", actor }),
    ).rejects.toThrow(SpeechUnavailable);
  });

  it("withdraws the announcement when the speaker can't be told", async () => {
    const asked: unknown[] = [];
    const url = await fakePiper(asked);
    announcements = createAnnouncements({
      host: "127.0.0.1",
      port: 0,
      log: () => {},
    });
    const speech = createSpeech({
      announcements,
      manager: {
        serviceUrl: async () => url,
        hostStatus: async () => ({ network: { address: "192.168.1.20" } }),
        wantServiceForCore: async () => {},
        releaseServiceForCore: async () => {},
      },
      devices: {
        list: () => [],
        announce: async () => {
          throw new Error("offline");
        },
      },
      areaOn: () => true,
      publishedPort: 4180,
      log: () => {},
    });
    await expect(
      speech.speak({
        device: "a",
        text: "Hi",
        language: "en",
        actor: { kind: "app", id: "sanctum.example" },
      }),
    ).rejects.toThrow("offline");
    expect(announcements.busy("a")).toBe(false);
    speech.stop();
  });
});
