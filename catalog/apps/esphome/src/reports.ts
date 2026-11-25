import type {
  AppContext,
  DeviceInfo,
  DeviceRegistration,
  MediaActivity,
} from "@meetsanctum/app-sdk";
import { MediaPlayerState, type TelemetryEvent } from "esphome-client";

import type { Session, Timings } from "./connection.js";
import { signalOf, type Mapping } from "./entities.js";
import type { Facts } from "./facts.js";
import { connectionFactsOf, describeSession } from "./session-details.js";
import { audioStateOf, mutedOf } from "./speaker.js";
import { stateOf } from "./states.js";
import { declineRequests } from "./voice.js";

// An announcement Sanctum sent, on the player that got it. The Voice PE's
// firmware reports an announcement it was asked for as playing, not
// announcing, so that player's playing reads as an announcement: from its
// first report of playing, which comes within a second of the command, until
// it reports anything else. Only a fetch of the clip lets an ordinary
// PLAYING report count as an announcement.
/** How soon the player says it's playing an announcement, or it didn't. */
const announcementStartsMs = 5_000;
/** The longest an announcement holds the player's own activity. */
const announcementHeldMs = 5 * 60_000;

// What a device says, told to the core: each part's state, each press once,
// and its Wi-Fi signal kept for its page.

/** Reports the current microphone state until the core takes it or the session ends. */
function audioReports(
  ctx: AppContext,
  key: string,
  timings: Pick<Timings, "firstPauseMs" | "longestPauseMs">,
  facts: Facts,
  current: () => Session | null,
) {
  let heardAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest = 0;
  const cancel = () => {
    clearTimeout(timer);
    latest += 1;
  };
  function send(session: Session, attempt = 0) {
    const { parts } = describeSession(session);
    if (!parts || current() !== session) return;
    cancel();
    const sent = latest;
    const audio = audioStateOf(mutedOf(session, parts), heardAt);
    ctx.devices.report({ key, states: { audio } }).catch((error: unknown) => {
      if (sent !== latest || current() !== session) return;
      ctx.log(`could not report microphones for ${key} (${String(error)})`);
      timer = setTimeout(
        () => send(session, attempt + 1),
        Math.min(timings.firstPauseMs * 2 ** attempt, timings.longestPauseMs),
      );
      timer.unref();
    });
  }
  return {
    send,
    cancel,
    async restore() {
      const at = await facts.lastHeard(key);
      if (at === null || heardAt !== null) return;
      heardAt = at;
      const session = current();
      if (session) send(session);
    },
    follow(session: Session, order: (write: () => Promise<void>) => void) {
      const { parts } = describeSession(session);
      declineRequests(session, () => {
        if (!parts) return;
        // Capture the time promptly. The caller orders the write with setup.
        const at = Date.now();
        heardAt = at;
        order(async () => {
          await facts.heard(key, at, connectionFactsOf(session));
          send(session);
        });
      });
    },
  };
}

export function createReports(
  ctx: AppContext,
  key: string,
  options: {
    timings: Pick<Timings, "firstPauseMs" | "longestPauseMs">;
    facts: Facts;
    current: () => Session | null;
    capabilities: DeviceInfo["capabilities"];
  },
) {
  const { timings, facts, current, capabilities } = options;
  const audio = audioReports(ctx, key, timings, facts, current);
  // Playback activity survives reconnects because announcements leave it unchanged.
  const activities = new Map(
    capabilities.flatMap((part) =>
      part.kind === "media" && part.observed
        ? [[part.id, part.observed.activity] as const]
        : [],
    ),
  );
  const announcements = new WeakMap<
    Session,
    {
      key: number;
      url: string;
      fetchedAt: number | null;
      started: boolean;
      held?: { events: TelemetryEvent[]; flush: () => void };
    }
  >();
  // An event from the player announcing, read as an announcement while it is
  // one, and the end of it otherwise.
  function readAnnouncement(
    event: TelemetryEvent,
    session: Session,
  ): TelemetryEvent {
    if (event.type !== "media_player") return event;
    const announcing = announcements.get(session);
    if (announcing?.key !== event.key || announcing.fetchedAt === null)
      return event;
    const since = Date.now() - announcing.fetchedAt;
    if (
      event.state === MediaPlayerState.PLAYING &&
      since < announcementHeldMs &&
      (announcing.started || since < announcementStartsMs)
    ) {
      announcing.started = true;
      return { ...event, state: MediaPlayerState.ANNOUNCING };
    }
    announcements.delete(session);
    return event;
  }
  function reportState(event: TelemetryEvent, session: Session) {
    const { mapping } = describeSession(session);
    report(
      ctx,
      facts,
      key,
      mapping,
      readAnnouncement(event, session),
      session,
      activities,
      audio.send,
    );
  }
  return {
    audio,
    /** An announcement went to the player with this key. */
    announced(session: Session, playerKey: number, url: string) {
      announcements.get(session)?.held?.flush();
      announcements.set(session, {
        key: playerKey,
        url,
        fetchedAt: null,
        started: false,
      });
    },
    announcementFetched(session: Session, url: string) {
      const announcing = announcements.get(session);
      if (announcing?.url === url) {
        announcing.fetchedAt ??= Date.now();
        announcing.held?.flush();
      }
    },
    registered(capabilities: DeviceRegistration["capabilities"]) {
      for (const id of activities.keys()) {
        if (
          !capabilities.some((part) => part.id === id && part.kind === "media")
        ) {
          activities.delete(id);
        }
      }
    },
    state(event: TelemetryEvent, session: Session) {
      const announcing = announcements.get(session);
      if (
        event.type === "media_player" &&
        announcing?.key === event.key &&
        announcing.fetchedAt === null
      ) {
        if (announcing.held) {
          announcing.held.events.push(event);
          return;
        }
        if (event.state === MediaPlayerState.PLAYING && current() === session) {
          // The fetch notice can arrive after playback. Keep this player's
          // reports in order while it has a chance to arrive.
          const events: TelemetryEvent[] = [event];
          const flush = () => {
            clearTimeout(timer);
            announcing.held = undefined;
            // No fetch: the announcement never played, so the player's
            // reports are its own again from here on.
            if (
              announcing.fetchedAt === null &&
              announcements.get(session) === announcing
            ) {
              announcements.delete(session);
            }
            if (current() !== session) return;
            for (const held of events) reportState(held, session);
          };
          const timer = setTimeout(flush, announcementStartsMs);
          timer.unref();
          announcing.held = { events, flush };
          return;
        }
      }
      reportState(event, session);
    },
  };
}

/**
 * Reports one thing a session's device said, read by that session's own
 * parts, with what it said before: what each media part was doing, which
 * an announcement leaves as it was.
 */
function report(
  ctx: AppContext,
  facts: Facts,
  mac: string,
  mapping: Mapping,
  event: TelemetryEvent,
  session: Session,
  activities: Map<string, MediaActivity>,
  tellAudio: (session: Session) => void,
) {
  // A state event names its entity by its key, which a type keeps apart.
  if (
    event.type === "sensor" &&
    event.key === signalOf(session.entities)?.key
  ) {
    if (
      typeof event.state === "number" &&
      Number.isFinite(event.state) &&
      !event.missingState
    ) {
      facts.signal(mac, Math.round(event.state)).catch((error: unknown) => {
        ctx.log(`could not save signal for ${mac} (${String(error)})`);
      });
    }
    return;
  }
  const mapped = mapping.mapped.find(
    (each) => each.entity.type === event.type && each.entity.key === event.key,
  );
  if (!mapped) return;
  const capability = mapped.capability.id;
  if (mapped.capability.kind === "audio") {
    tellAudio(session);
    return;
  }
  const sent =
    event.type === "event"
      ? typeof event.eventType === "string" &&
        (mapped.capability.features as { actions: string[] }).actions.includes(
          event.eventType,
        )
        ? ctx.devices.press({
            key: mac,
            capability,
            action: event.eventType,
          })
        : null
      : (() => {
          const now = stateOf(mapped, event, activities.get(capability));
          if (now && "activity" in now) {
            activities.set(capability, now.activity);
          }
          return now
            ? ctx.devices.report({
                key: mac,
                states: { [capability]: now },
              })
            : null;
        })();
  sent?.catch((error: unknown) => {
    ctx.log(`could not report ${mac} (${String(error)})`);
  });
}
