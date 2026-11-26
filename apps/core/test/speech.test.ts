import type { DeviceInfo } from "@meetsanctum/app-sdk";
import type { Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  announcementKeptMs,
  createAnnouncements,
  type Announcements,
} from "../src/speech/announcements.js";
import { assembleSpeech } from "../src/speech/assembly.js";
import {
  createSpeech,
  SpeechSwitchedOff,
  SpeechUnavailable,
  voices,
} from "../src/speech/speech.js";
import * as wyoming from "../src/speech/wyoming.js";
import { fakeManager } from "./manager-support.js";
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
  cidr?: string;
  want?: (signal: AbortSignal) => Promise<void>;
  chime?: { rate: number; samples: Int16Array }[];
  log?: (message: string) => void;
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
                cidr: options.cidr ?? "192.168.1.20/24",
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
      announce: async (device, url, _actor, fetched) => {
        if (!fetched) told.push({ device, url });
      },
    },
    areaOn: () => areaOn,
    publishedPort: 4180,
    ...(options.chime ? { chime: options.chime } : {}),
    log: options.log ?? (() => {}),
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

it("releases the core's Piper request when no speaker port is configured", async () => {
  const releaseServiceForCore = vi.fn(async () => {});
  const { startSpeech, stopSpeech } = assembleSpeech({
    manager: {
      serviceUrl: async () => null,
      hostStatus: fakeManager().manager.hostStatus,
      wantServiceForCore: vi.fn(async () => {}),
      releaseServiceForCore,
    },
    devices: { list: () => [], announce: async () => {} },
    areaOn: () => true,
    log: () => {},
  });
  await startSpeech();
  expect(releaseServiceForCore).toHaveBeenCalledWith("piper", {
    signal: expect.any(AbortSignal),
  });
  await stopSpeech();
});

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

  it("releases Piper and cannot dispatch while the listener is down", async () => {
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
    expect(calls).toEqual(["release piper"]);
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

  it("loads each voice once Piper listens, though it refused at first", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const loaded: string[] = [];
    let listening = false;
    const synthesize = vi
      .spyOn(wyoming, "synthesize")
      .mockImplementation(async function* ({ voice }) {
        loaded.push(voice);
        if (!listening) throw new Error("connect ECONNREFUSED");
        yield { rate: 22_050, samples: new Int16Array(100) };
      });
    const logged: string[] = [];
    const { speech } = setup({
      devices: [speaker("a", true)],
      serviceUrl: "tcp://127.0.0.1:1",
      log: (message) => logged.push(message),
    });
    announcements!.port = () => 4180;
    try {
      speech.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(loaded).toEqual([voices.en, voices.de]);
      listening = true;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(loaded).toEqual([voices.en, voices.de, voices.en, voices.de]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(loaded).toHaveLength(4);
      expect(logged).toEqual([]);
    } finally {
      speech.stop();
      synthesize.mockRestore();
      vi.useRealTimers();
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

  it("tells the speaker only once there is sound to play", async () => {
    const loading = deferredDelivery();
    const finishing = deferredDelivery();
    const partial = deferredDelivery();
    const synthesize = vi
      .spyOn(wyoming, "synthesize")
      .mockImplementation(async function* () {
        await loading.promise;
        yield { rate: 22_050, samples: new Int16Array(100) };
        partial.resolve();
        await finishing.promise;
      });
    const { speech, told } = setup({
      devices: [],
      serviceUrl: "tcp://127.0.0.1:1",
    });
    announcements!.port = () => 4180;
    speech.start();
    try {
      const said = speech.speak({
        device: "a",
        text: "Hi",
        language: "en",
        actor: { kind: "app", id: "sanctum.example" },
      });
      await settle();
      // The voice is still loading: nothing for the speaker to fetch yet.
      expect(told).toEqual([]);
      expect(announcements!.busy("a")).toBe(true);
      loading.resolve();
      await partial.promise;
      await settle();
      expect(told).toEqual([]);
      finishing.resolve();
      expect(await (await said).encoded).toBe(true);
      expect(told).toHaveLength(1);
    } finally {
      finishing.resolve();
      speech.stop();
      synthesize.mockRestore();
    }
  });

  it("hands a request its reply's address, a confirmation's as the chime", async () => {
    const synthesize = vi
      .spyOn(wyoming, "synthesize")
      .mockImplementation(async function* () {
        yield { rate: 22_050, samples: new Int16Array(4096) };
      });
    const chime = [{ rate: 22_050, samples: new Int16Array(2048) }];
    // No Piper: only the chime plays.
    const { speech, told } = setup({ devices: [], serviceUrl: null, chime });
    announcements!.port = () => 4180;
    speech.start();
    try {
      const url = await speech.reply({
        device: "a",
        text: "Turned off the Office lights",
        language: "en",
        confirmation: true,
      });
      expect(url).toMatch(/^http:\/\/192\.168\.1\.20:4180\/a\/.+\.flac$/);
      expect(synthesize).not.toHaveBeenCalled();
      // The run hands it on: the speaker isn't told as for an announcement.
      expect(told).toEqual([]);
      await expect(
        speech.reply({ device: "a", text: "Hi", language: "en" }),
      ).rejects.toThrow(SpeechUnavailable);
    } finally {
      speech.stop();
      synthesize.mockRestore();
    }
  });

  it("says a confirmation's words where there is no chime", async () => {
    const synthesize = vi
      .spyOn(wyoming, "synthesize")
      .mockImplementation(async function* () {
        yield { rate: 22_050, samples: new Int16Array(4096) };
      });
    const { speech } = setup({
      devices: [],
      serviceUrl: "tcp://127.0.0.1:1",
      areaOn: false,
    });
    announcements!.port = () => 4180;
    speech.start();
    try {
      // Whether or not AI agents may speak: it finishes someone's request.
      await speech.reply({
        device: "a",
        text: "Turned off the Office lights",
        language: "en",
        confirmation: true,
      });
      expect(synthesize).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Turned off the Office lights" }),
      );
    } finally {
      speech.stop();
      synthesize.mockRestore();
    }
  });

  it("does not send a URL withdrawn after the first playable frame", async () => {
    const synthesize = vi
      .spyOn(wyoming, "synthesize")
      .mockImplementation(async function* () {
        yield { rate: 22_050, samples: new Int16Array(4096) };
        throw new Error("The service disconnected");
      });
    const { speech, told } = setup({
      devices: [],
      serviceUrl: "tcp://127.0.0.1:1",
    });
    announcements!.port = () => 4180;
    speech.start();
    try {
      await expect(
        speech.speak({
          device: "a",
          text: "Hi",
          language: "en",
          actor: { kind: "app", id: "sanctum.example" },
        }),
      ).rejects.toThrow(SpeechUnavailable);
      expect(told).toEqual([]);
    } finally {
      speech.stop();
      synthesize.mockRestore();
    }
  });

  it("dispatches a waiting announcement only after the first clip has had time to play", async () => {
    const { server, url } = await fakePiper([]);
    piper = server;
    const { speech, told } = setup({
      devices: [],
      serviceUrl: url,
      address: "127.0.0.1",
      cidr: "127.0.0.1/32",
    });
    await announcements!.start();
    speech.start();
    const created = vi.spyOn(announcements!, "create");
    const speak = (text: string) =>
      speech.speak({
        device: "a",
        text,
        language: "en",
        actor: { kind: "app", id: "sanctum.example" },
      });
    try {
      await speak("First");
      const second = speak("Second");
      await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(2));
      expect(await created.mock.results[1]!.value.encoded).toBe(true);
      expect(told).toHaveLength(1);
      const firstUrl = new URL(told[0]!.url);
      firstUrl.port = String(announcements!.port());
      const response = await fetch(firstUrl);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(told).toHaveLength(1);
      await second;
      expect(told).toHaveLength(2);
    } finally {
      speech.stop();
    }
  });

  it("keeps a finishing reply queued while the acknowledgement waits to be fetched", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const synthesize = vi
      .spyOn(wyoming, "synthesize")
      .mockImplementation(async function* () {
        yield { rate: 22_050, samples: new Int16Array(4096) };
      });
    const { speech, told } = setup({
      devices: [],
      serviceUrl: "tcp://127.0.0.1:1",
    });
    announcements!.port = () => 4180;
    speech.start();
    try {
      await speech.reply({ device: "a", text: "One moment", language: "en" });
      const reply = speech.speak({
        device: "a",
        text: "Done",
        language: "en",
        actor: { kind: "app", id: "sanctum.assistant" },
        finishing: true,
      });
      const dispatched = reply.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(announcementKeptMs - 1);
      expect(told).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await dispatched).toHaveProperty("encoded");
      expect(told).toHaveLength(1);
    } finally {
      speech.stop();
      synthesize.mockRestore();
      vi.useRealTimers();
    }
  });

  it("says nothing more once AI agents may no longer speak, waiting or told", async () => {
    const { server, url } = await fakePiper([]);
    piper = server;
    const { speech, told, setArea } = setup({
      devices: [],
      serviceUrl: url,
      address: "127.0.0.1",
      cidr: "127.0.0.1/32",
    });
    await announcements!.start();
    speech.start();
    const created = vi.spyOn(announcements!, "create");
    const delivered: boolean[] = [];
    const speak = (text: string) =>
      speech.speak({
        device: "a",
        text,
        language: "en",
        actor: { kind: "app", id: "sanctum.example" },
        onDelivery: (fetched) => delivered.push(fetched),
      });
    try {
      await speak("First");
      const second = speak("Second");
      await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(2));
      setArea(false);
      await expect(second).rejects.toThrow(SpeechSwitchedOff);
      expect(told).toHaveLength(1);
      // The speaker was told the first, but it's gone before the fetch.
      const firstUrl = new URL(told[0]!.url);
      firstUrl.port = String(announcements!.port());
      await expect(fetch(firstUrl)).rejects.toThrow();
      await vi.waitFor(() => expect(delivered).toEqual([false]));
      expect(announcements!.busy("a")).toBe(false);
    } finally {
      speech.stop();
    }
  });

  it("withdraws queued speech before the caller times out", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const synthesize = vi
      .spyOn(wyoming, "synthesize")
      .mockImplementation(async function* () {
        yield { rate: 22_050, samples: new Int16Array(100) };
      });
    const { speech, told } = setup({
      devices: [],
      serviceUrl: "tcp://127.0.0.1:1",
    });
    announcements!.port = () => 4180;
    speech.start();
    const speak = () =>
      speech.speak({
        device: "a",
        text: "Hi",
        language: "en",
        actor: { kind: "app", id: "sanctum.example" },
      });
    try {
      await speak();
      const rejected = expect(speak()).rejects.toThrow(
        "didn't take the announcement in time",
      );
      await vi.advanceTimersByTimeAsync(59_000);
      await rejected;
      await vi.advanceTimersByTimeAsync(1_001);
      expect(told).toHaveLength(1);
      expect(announcements!.busy("a")).toBe(false);
    } finally {
      speech.stop();
      await announcements!.stop();
      synthesize.mockRestore();
      vi.useRealTimers();
    }
  });

  it("tells no speaker about speech that fails before any sound", async () => {
    const synthesize = vi
      .spyOn(wyoming, "synthesize")
      .mockImplementation(async function* () {
        yield* [];
        throw new Error("connect ECONNREFUSED");
      });
    const { speech, told } = setup({
      devices: [],
      serviceUrl: "tcp://127.0.0.1:1",
    });
    announcements!.port = () => 4180;
    speech.start();
    try {
      await expect(
        speech.speak({
          device: "a",
          text: "Hi",
          language: "en",
          actor: { kind: "app", id: "sanctum.example" },
        }),
      ).rejects.toThrow(SpeechUnavailable);
      expect(told).toEqual([]);
      expect(announcements!.busy("a")).toBe(false);
    } finally {
      speech.stop();
      synthesize.mockRestore();
    }
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
