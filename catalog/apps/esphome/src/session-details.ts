import type { Session } from "./connection.js";
import { mapEntities } from "./entities.js";
import { speakerPartsOf } from "./speaker.js";

// Each connection has its own entity keys and capabilities.
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
