import { announcePermission } from "@meetsanctum/app-sdk";

import type { AgentsCanUse } from "../agents/can-use.js";
import type { ManagerClient } from "../manager.js";
import { createAnnouncements } from "./announcements.js";
import { assembleHearing } from "./hearing.js";
import { createSpeech, speechLanguages, speechService } from "./speech.js";
import { spokenPhrases } from "./spoken.js";

type HearingOptions = Parameters<typeof assembleHearing>[0];

export function assembleSpeakerAudio(
  config: Pick<
    Parameters<typeof assembleSpeech>[0],
    "speaker" | "manager" | "log"
  > &
    Pick<HearingOptions, "transcriber">,
  options: Pick<HearingOptions, "devices" | "places" | "apps" | "record"> & {
    canUse: Pick<AgentsCanUse, "areaOn">;
  },
) {
  const speech = assembleSpeech({
    speaker: config.speaker,
    manager: config.manager,
    log: config.log,
    devices: options.devices,
    areaOn: () => options.canUse.areaOn(announcePermission),
    hears: () => Boolean(config.transcriber?.()),
  });
  const hearing = assembleHearing({
    ...options,
    transcriber: config.transcriber,
    log: config.log,
    speech: () => speech.speech,
  });
  return { ...speech, ...hearing };
}

export function assembleSpeech(options: {
  speaker?: { host: string; port: number; publishedPort: number };
  manager: Pick<ManagerClient, "serviceUrl" | "hostStatus"> &
    Partial<
      Pick<ManagerClient, "wantServiceForCore" | "releaseServiceForCore">
    >;
  devices: Parameters<typeof createSpeech>[0]["devices"];
  areaOn: () => boolean;
  hears?: () => boolean;
  log: (message: string) => void;
}) {
  const { speaker, manager, devices, areaOn, log } = options;
  const { serviceUrl, hostStatus, wantServiceForCore, releaseServiceForCore } =
    manager;
  let releasing: AbortController | undefined;
  const announcements =
    speaker && wantServiceForCore && releaseServiceForCore
      ? createAnnouncements({ host: speaker.host, port: speaker.port, log })
      : undefined;
  const speech =
    speaker && announcements && wantServiceForCore && releaseServiceForCore
      ? createSpeech({
          announcements,
          manager: {
            serviceUrl,
            hostStatus,
            wantServiceForCore,
            releaseServiceForCore,
          },
          devices,
          areaOn,
          hears: options.hears,
          chime: [successChime()],
          publishedPort: speaker.publishedPort,
          keptPhrases: Object.values(spokenPhrases).flatMap((phrase) =>
            speechLanguages.map((language) => ({
              language,
              text: phrase[language],
            })),
          ),
          log,
        })
      : undefined;

  return {
    speech,
    async startSpeech() {
      if (!announcements || !speech) {
        if (!releaseServiceForCore || releasing) return;
        releasing = new AbortController();
        const { signal } = releasing;
        void releaseServiceForCore(speechService, { signal }).catch(
          (error: unknown) => {
            if (!signal.aborted)
              log(
                `Speech couldn't stop: ${error instanceof Error ? error.message : String(error)}`,
              );
          },
        );
        return;
      }
      try {
        await announcements.start();
      } catch (error) {
        log(
          `speech: smart speakers can't fetch announcements on port ${speaker?.port} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      speech.start();
    },
    async stopSpeech() {
      releasing?.abort();
      releasing = undefined;
      speech?.stop();
      await announcements?.stop();
    },
  };
}

// Two soft, rising notes with fades to avoid clicks at their edges.
function successChime() {
  const rate = 22_050;
  const noteLength = Math.round(rate * 0.14);
  const samples = new Int16Array(noteLength * 2);
  for (const [note, frequency] of [660, 880].entries()) {
    for (let i = 0; i < noteLength; i++) {
      const fade = Math.sin((Math.PI * i) / noteLength) ** 2;
      const wave = Math.sin((2 * Math.PI * frequency * i) / rate);
      samples[note * noteLength + i] = Math.round(4_000 * fade * wave);
    }
  }
  return { rate, samples };
}
