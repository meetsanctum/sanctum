import type { DeviceInfo } from "@meetsanctum/app-sdk";
import type { Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  announcementKeptMs,
  createAnnouncements,
  type Announcements,
} from "../src/speech/announcements.js";
import {
  createSpeech,
  SpeechUnavailable,
  voices,
} from "../src/speech/speech.js";
import * as wyoming from "../src/speech/wyoming.js";
import { fakePiper } from "./speech-support.js";
import { deferredDelivery, deferredResult } from "./support.js";

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

function setup(options: {
  devices: DeviceInfo[];
  areaOn?: boolean;
  serviceUrl?: string | null;
  getServiceUrl?: () => Promise<string | null>;
  getAddress?: () => string;
  address?: string | null;
  want?: (signal: AbortSignal) => Promise<void>;
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
      serviceUrl:
        options.getServiceUrl ?? (async () => options.serviceUrl ?? null),
      hostStatus: async () => ({
        network:
          options.address === null
            ? null
            : {
                address:
                  options.getAddress?.() ?? options.address ?? "192.168.1.20",
                cidr: "192.168.1.20/24",
              },
      }),
      wantServiceForCore: async (service, { signal }) => {
        calls.push(`want ${service}`);
        await options.want?.(signal);
      },
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
    announcements!.port = () => 4180;
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
    announcements!.port = () => 4180;
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

  it("does not request Piper or dispatch while the listener is down", async () => {
    const { speech, calls, setArea } = setup({
      devices: [speaker("a", true)],
      serviceUrl: "tcp://127.0.0.1:1",
    });
    speech.start();
    setArea(false);
    setArea(true);
    await expect(
      speech.speak({
        device: "a",
        text: "Hi",
        language: "en",
        actor: { kind: "app", id: "sanctum.example" },
      }),
    ).rejects.toThrow(SpeechUnavailable);
    expect(calls).toEqual([]);
  });

  it("waits for a superseded manager request before applying the latest setting", async () => {
    const cancelled = deferredDelivery();
    const settled = deferredDelivery();
    const { speech, calls, setArea } = setup({
      devices: [speaker("a", true)],
      async want(signal) {
        signal.addEventListener("abort", cancelled.resolve, { once: true });
        await settled.promise;
      },
    });
    announcements!.port = () => 4180;
    speech.start();
    setArea(false);
    await cancelled.promise;
    expect(calls).toEqual(["want piper"]);
    settled.resolve();
    await settled.promise;
    await settle();
    expect(calls).toEqual(["want piper", "release piper"]);
    speech.stop();
  });

  it("does not open a warmup connection after stopping during endpoint lookup", async () => {
    const requested = deferredDelivery();
    const endpoint = deferredResult<string>();
    const synthesize = vi.spyOn(wyoming, "synthesize");
    try {
      const { speech } = setup({
        devices: [speaker("a", true)],
        getServiceUrl() {
          requested.resolve();
          return endpoint.promise;
        },
      });
      announcements!.port = () => 4180;
      speech.start();
      await requested.promise;
      speech.stop();
      endpoint.resolve("tcp://127.0.0.1:1");
      await settle();
      expect(synthesize).not.toHaveBeenCalled();
    } finally {
      synthesize.mockRestore();
    }
  });

  it("says the words in the language's voice and tells the speaker its address", async () => {
    const asked: unknown[] = [];
    const { server, url } = await fakePiper(asked);
    piper = server;
    const { speech, told } = setup({
      devices: [speaker("a", true)],
      serviceUrl: url,
    });
    await announcements!.start();
    speech.start();
    const said = await speech.speak({
      device: "a",
      text: "Das Essen ist fertig.",
      language: "de",
      actor: { kind: "app", id: "sanctum.example" },
    });
    expect(await said.encoded).toBe(true);
    expect(told).toHaveLength(1);
    expect(told[0]!.url).toMatch(
      /^http:\/\/192\.168\.1\.20:4180\/a\/.+\.flac$/,
    );
    expect(asked).toContainEqual({
      type: "synthesize",
      data: { text: "Das Essen ist fertig.", voice: { name: voices.de } },
    });
    speech.stop();
  });

  it("is unavailable while Piper isn't running or the host's address is unknown", async () => {
    const actor = { kind: "app", id: "sanctum.example" } as const;
    const stopped = setup({ devices: [speaker("a", true)], serviceUrl: null });
    await announcements!.start();
    stopped.speech.start();
    await expect(
      stopped.speech.speak({ device: "a", text: "Hi", language: "en", actor }),
    ).rejects.toThrow(SpeechUnavailable);
    stopped.speech.stop();
    await announcements!.stop();
    const nowhere = setup({
      devices: [speaker("a", true)],
      serviceUrl: "tcp://127.0.0.1:1",
      address: null,
    });
    await announcements!.start();
    nowhere.speech.start();
    await expect(
      nowhere.speech.speak({ device: "a", text: "Hi", language: "en", actor }),
    ).rejects.toThrow(SpeechUnavailable);
    nowhere.speech.stop();
  });

  it("looks up the host's new address after an announcement expires unfetched", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const synthesize = vi
      .spyOn(wyoming, "synthesize")
      .mockImplementation(async function* () {
        yield { rate: 22_050, samples: new Int16Array(100) };
      });
    let address = "192.168.1.20";
    const getAddress = vi.fn(() => address);
    const { speech, told } = setup({
      devices: [],
      serviceUrl: "tcp://127.0.0.1:1",
      getAddress,
    });
    announcements!.port = () => 4180;
    speech.start();
    const speak = (device: string) =>
      speech.speak({
        device,
        text: "Hi",
        language: "en",
        actor: { kind: "app", id: "sanctum.example" },
      });
    try {
      expect(await (await speak("a")).encoded).toBe(true);
      address = "192.168.1.21";
      vi.advanceTimersByTime(announcementKeptMs - 1);
      expect(await (await speak("b")).encoded).toBe(true);
      expect(getAddress).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(await (await speak("a")).encoded).toBe(true);
      expect(getAddress).toHaveBeenCalledTimes(2);
      expect(told.map(({ url }) => new URL(url).hostname)).toEqual([
        "192.168.1.20",
        "192.168.1.20",
        "192.168.1.21",
      ]);
    } finally {
      speech.stop();
      await announcements!.stop();
      synthesize.mockRestore();
      vi.useRealTimers();
    }
  });

  it("withdraws the announcement when the speaker can't be told", async () => {
    const asked: unknown[] = [];
    const { server, url } = await fakePiper(asked);
    piper = server;
    announcements = createAnnouncements({
      host: "127.0.0.1",
      port: 0,
      log: () => {},
    });
    const speech = createSpeech({
      announcements,
      manager: {
        serviceUrl: async () => url,
        hostStatus: async () => ({
          network: { address: "192.168.1.20", cidr: "192.168.1.20/24" },
        }),
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
    await announcements!.start();
    speech.start();
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
