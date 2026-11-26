import type { ManagerClient } from "../manager.js";
import { createAnnouncements } from "./announcements.js";
import { createSpeech, speechLanguages, speechService } from "./speech.js";
import { spokenPhrases } from "./spoken.js";

export function assembleSpeech(options: {
  speaker?: { host: string; port: number; publishedPort: number };
  manager: Pick<ManagerClient, "serviceUrl" | "hostStatus"> &
    Partial<
      Pick<ManagerClient, "wantServiceForCore" | "releaseServiceForCore">
    >;
  devices: Parameters<typeof createSpeech>[0]["devices"];
  areaOn: () => boolean;
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
