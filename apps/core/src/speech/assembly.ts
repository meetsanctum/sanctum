import type { ManagerClient } from "../manager.js";
import { createAnnouncements } from "./announcements.js";
import { createSpeech } from "./speech.js";

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
          log,
        })
      : undefined;

  return {
    speech,
    async startSpeech() {
      if (!announcements || !speech) return;
      try {
        await announcements.start();
      } catch (error) {
        log(
          `speech: smart speakers can't fetch announcements on port ${speaker?.port} (${error instanceof Error ? error.message : String(error)})`,
        );
        return;
      }
      speech.start();
    },
    async stopSpeech() {
      speech?.stop();
      await announcements?.stop();
    },
  };
}
