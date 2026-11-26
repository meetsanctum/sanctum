import { maxDeviceCapabilities } from "@meetsanctum/app-sdk";
import { MediaPlayerFormatPurpose, type Entity } from "esphome-client";

import type { Session } from "./connection.js";
import { mapEntities } from "./entities.js";
import { streamsOverApi } from "./registration.js";
import { speakerPartsOf } from "./speaker.js";

// Each connection has its own entity keys and capabilities. A device with a
// voice assistant that plays has microphones, its `audio` part: its Mute
// switch where it has one, a setting of its own that no other device's
// switch would be, which Sanctum then mutes it with. It announces where its
// media player lists a format for announcements, which it then plays over
// whatever it was playing. It listens where it can stream its microphone
// over the encrypted API connection, which its driver then hands the core.
type SessionDescription = Parameters<typeof speakerPartsOf>[0] &
  Pick<Session, "encrypted">;
const sessions = new WeakMap<
  SessionDescription,
  {
    parts: ReturnType<typeof speakerPartsOf>;
    mapping: ReturnType<typeof mapEntities>;
    listens: boolean;
    announcementPlayer: Extract<Entity, { type: "media_player" }> | undefined;
  }
>();

export function describeSession(session: SessionDescription) {
  const cached = sessions.get(session);
  if (cached) return cached;
  const mapping = mapEntities(session.entities);
  const announcement = mapping.mapped.find(
    ({ entity }) =>
      entity.type === "media_player" &&
      (entity.supportedFormats ?? []).some(
        (format) =>
          format.purpose === MediaPlayerFormatPurpose.ANNOUNCEMENT &&
          String(format.format).toLowerCase() === "flac",
      ),
  );
  const player =
    announcement ??
    mapping.mapped.find(({ capability }) => capability.kind === "media");
  const parts = player ? speakerPartsOf(session) : null;
  const listens =
    parts !== null && session.encrypted && streamsOverApi(session.info);
  if (parts && player) {
    if (mapping.mapped.length === maxDeviceCapabilities) {
      // Keep playback and make room for the speaker's microphones.
      const last = mapping.mapped.length - 1;
      const [extra] = mapping.mapped.splice(
        mapping.mapped[last] === player ? last - 1 : last,
        1,
      );
      if (extra && extra.entity.disabledByDefault !== true) {
        mapping.unused.unshift(extra.entity);
      }
    }
    const mutes = parts.mute !== null;
    mapping.mapped.push({
      capability: {
        id: "audio",
        kind: "audio",
        features: {
          mutes,
          muteSwitch: mutes,
          announces: announcement !== undefined,
          listens,
          announcementPlayer: announcement?.capability.id,
        },
      },
      // Its media player's stands in where it has no Mute switch, whose
      // reports are the media part's.
      entity: parts.mute ?? player.entity,
    });
  }
  const details = {
    parts,
    mapping,
    listens,
    announcementPlayer:
      parts && announcement?.entity.type === "media_player"
        ? announcement.entity
        : undefined,
  };
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
