import type { Session } from "./connection.js";
import { hasVoiceAssistant } from "./registration.js";

// A device with a voice assistant, such as a smart speaker, waits for an
// assistant to follow its requests: until one does, it counts itself as
// starting up, so its ring twinkles and its button does nothing. Sanctum
// follows them on each of its connections and declines every request at
// once, before the device sends any sound, so the device shows that nothing
// answered it and nothing it hears leaves it.

/**
 * Follows a session's voice requests, if its device has a voice assistant,
 * declining each, until the session ends.
 */
export function declineRequests(session: Session) {
  if (!hasVoiceAssistant(session.info)) return;
  const { client } = session;
  const ended = new AbortController();
  client.on("lifecycle", (event) => {
    if (event.kind === "disconnect") ended.abort();
  });
  const requests = client.voiceAssistant;
  // No audio is asked for: none is ever taken.
  requests.subscribe();
  void (async () => {
    try {
      for await (const request of requests.requests({
        signal: ended.signal,
      })) {
        if (!request.start) continue;
        requests.respondToRequest({ error: true });
      }
    } catch {
      // Ended with its session.
    }
  })();
}
