import { describe, expect, it, vi } from "vitest";

import { maxAnnouncements } from "../src/speech/announcements.js";
import { SpeechUnavailable } from "../src/speech/speech.js";
import * as wyoming from "../src/speech/wyoming.js";
import { setupSpeech } from "./speech-service-support.js";

describe("speech chimes", () => {
  it("hands a request its reply's address, a confirmation's as the chime", async () => {
    const synthesize = vi
      .spyOn(wyoming, "synthesize")
      .mockImplementation(async function* () {
        yield { rate: 22_050, samples: new Int16Array(4096) };
      });
    const chime = [{ rate: 22_050, samples: new Int16Array(2048) }];
    // No Piper: only the chime plays.
    const { announcements, speech, told } = setupSpeech({
      devices: [],
      serviceUrl: null,
      chime,
    });
    announcements.port = () => 4180;
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

  it("tells a speaker the error chime's address, without Piper and whatever the area says", async () => {
    const errorChime = [{ rate: 22_050, samples: new Int16Array(2048) }];
    const { announcements, speech, told } = setupSpeech({
      devices: [],
      serviceUrl: null,
      areaOn: false,
      errorChime,
    });
    announcements.port = () => 4180;
    speech.start();
    try {
      await speech.playError({
        device: "a",
        actor: { kind: "app", id: "sanctum.example" },
      });
      expect(told).toEqual([
        {
          device: "a",
          url: expect.stringMatching(
            /^http:\/\/192\.168\.1\.20:4180\/a\/.+\.flac$/,
          ),
        },
      ]);
    } finally {
      speech.stop();
    }
  });

  it("plays no error chime where there is none", async () => {
    const { announcements, speech, told } = setupSpeech({
      devices: [],
      serviceUrl: null,
    });
    announcements.port = () => 4180;
    speech.start();
    try {
      await expect(
        speech.playError({
          device: "a",
          actor: { kind: "app", id: "sanctum.example" },
        }),
      ).rejects.toThrow(SpeechUnavailable);
      expect(told).toEqual([]);
    } finally {
      speech.stop();
    }
  });

  it.each(["announcement", "reply"] as const)(
    "makes room for a regular %s while the home is full of unfetched error chimes",
    async (kind) => {
      const sound = [{ rate: 22_050, samples: new Int16Array(2048) }];
      const { announcements, speech } = setupSpeech({
        devices: [],
        chime: sound,
        errorChime: sound,
      });
      const actor = { kind: "app", id: "sanctum.example" } as const;
      announcements.port = () => 4180;
      speech.start();
      try {
        for (let i = 0; i < maxAnnouncements; i++) {
          await speech.playError({ device: `speaker-${i}`, actor });
        }
        const input = {
          device: "other-speaker",
          text: "Done",
          language: "en",
          confirmation: true,
        } as const;
        if (kind === "announcement") {
          expect(await (await speech.speak({ ...input, actor })).encoded).toBe(
            true,
          );
        } else {
          expect(await speech.reply(input)).toMatch(/\.flac$/);
        }
        expect(announcements.busy("other-speaker")).toBe(true);
        const stillWaiting = Array.from({ length: maxAnnouncements }, (_, i) =>
          announcements.busy(`speaker-${i}`),
        );
        expect(stillWaiting.filter(Boolean)).toHaveLength(maxAnnouncements - 1);
      } finally {
        speech.stop();
      }
    },
  );

  it("says a confirmation's words where there is no chime", async () => {
    const synthesize = vi
      .spyOn(wyoming, "synthesize")
      .mockImplementation(async function* () {
        yield { rate: 22_050, samples: new Int16Array(4096) };
      });
    const { announcements, speech } = setupSpeech({
      devices: [],
      serviceUrl: "tcp://127.0.0.1:1",
      areaOn: false,
    });
    announcements.port = () => 4180;
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
});
