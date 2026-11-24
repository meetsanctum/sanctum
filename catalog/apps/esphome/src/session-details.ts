import type { Session } from "./connection.js";
import { mapEntities } from "./entities.js";
import { speakerPartsOf } from "./speaker.js";

// Each connection has its own entity keys and capabilities. A device with a
// voice assistant that plays has microphones, its `audio` part: its Mute
// switch where it has one, a setting of its own that no other device's
// switch would be, which Sanctum then mutes it with.
const sessions = new WeakMap<
  Session,
  {
    parts: ReturnType<typeof speakerPartsOf>;
    mapping: ReturnType<typeof mapEntities>;
  }
>();

export function describeSession(session: Session) {
  const cached = sessions.get(session);
  if (cached) return cached;
  const mapping = mapEntities(session.entities);
  const parts = mapping.mapped.some(
    ({ capability }) => capability.kind === "media",
  )
    ? speakerPartsOf(session)
    : null;
  const player = mapping.mapped.find(
    ({ capability }) => capability.kind === "media",
  );
  if (parts && player) {
    const mutes = parts.mute !== null;
    mapping.mapped.push({
      capability: {
        id: "audio",
        kind: "audio",
        features: { mutes, muteSwitch: mutes },
      },
      // Its media player's stands in where it has no Mute switch, whose
      // reports are the media part's.
      entity: parts.mute ?? player.entity,
    });
  }
  const details = { parts, mapping };
  sessions.set(session, details);
  return details;
}

export function connectionFactsOf(session: Session) {
  const { parts, mapping } = describeSession(session);
  return {
    address: `${session.address.host}:${session.address.port}`,
    encrypted: session.encrypted,
    version: session.info.esphomeVersion ?? null,
    unused: mapping.unused
      .filter((entity) => entity !== parts?.mute && entity !== parts?.ring)
      .map(({ name }) => name),
    sleeps: session.info.hasDeepSleep === true,
  };
}
