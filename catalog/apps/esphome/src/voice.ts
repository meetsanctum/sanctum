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
  const requests = client.voiceAssistant;
  const listener = client.on("voiceAssistantRequest", (request) => {
    if (request.start) requests.respondToRequest({ error: true });
  });
  const lifecycle = client.on("lifecycle", (event) => {
    if (event.kind !== "disconnect") return;
    listener[Symbol.dispose]();
    lifecycle[Symbol.dispose]();
  });
  // No audio is asked for: none is ever taken.
  requests.subscribe();
}
