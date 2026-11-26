import type {
  ListenError,
  ListenStep,
  RefusedRun,
  VoiceRun,
} from "@meetsanctum/app-sdk";
import {
  entityId,
  MediaPlayerState,
  VoiceAssistantEvent,
  VoiceAssistantSubscribeFlag,
} from "esphome-client";

import type { Session } from "./connection.js";
import { hasVoiceAssistant } from "./registration.js";
import { describeSession } from "./session-details.js";

// A device with a voice assistant, such as a smart speaker, waits for an
// assistant to follow its requests: until one does, it counts itself as
// starting up, so its ring twinkles and its button does nothing. Sanctum
// follows them on each of its connections.
//
// As the device hears its wake word, the driver asks the core whether it
// takes the request (ctx.audio.listen) before the device sends any sound.
// Refused, or on a device that can't stream its microphone over an encrypted
// API connection, the request is declined before any sound leaves it, and its
// run is ended: a device ends its run only when told, and until then a
// Voice PE's ring stays red, as Home Assistant ends a run after an error.
// Taken, the device streams its microphone, which goes to the core as it
// comes, and the driver shows the core's steps on the device.

// The codes the device shows as an error. A Voice PE shows nothing for
// stt-no-text-recognized, on purpose, and its ring turns red for any other.
const errorCodes: Record<ListenError, string> = {
  "nothing-heard": "stt-no-text-recognized",
  "not-understood": "intent-not-understood",
  failed: "pipeline-failed",
};

type Data = { name: string; value: string }[];

/**
 * Follows a session's voice requests, if its device has a voice assistant,
 * until the session ends: each opens a run with `listen`, or is declined.
 * The wake phrase distinguishes a local wake-word detection from a button
 * press.
 */
export function followRequests(
  session: Session,
  options: {
    listens: boolean;
    listen: (wakeWord: string | null) => Promise<VoiceRun | RefusedRun>;
    heard: () => void;
    log: (message: string) => void;
  },
) {
  if (!hasVoiceAssistant(session.info)) return;
  const { client } = session;
  const requests = client.voiceAssistant;
  const send = (event: VoiceAssistantEvent, data?: Data) =>
    requests.sendEvent(event, data);
  let current: VoiceRun | null = null;
  let pending: symbol | null = null;
  let gone = false;
  const player = describeSession(session).announcementPlayer;
  let playback: {
    run: VoiceRun;
    started: boolean;
    wasPlaying: boolean;
  } | null = null;

  function decline() {
    requests.respondToRequest({ error: true });
    send(VoiceAssistantEvent.RUN_END);
  }

  function show(step: ListenStep, run: VoiceRun) {
    switch (step.step) {
      case "stopped":
        send(VoiceAssistantEvent.STT_VAD_END);
        return;
      case "heard":
        send(VoiceAssistantEvent.STT_END, [{ name: "text", value: step.text }]);
        return;
      case "reply":
        if (player) {
          const before = client.latest(
            entityId("media_player", player.objectId),
          );
          playback = {
            run,
            started: false,
            wasPlaying: before?.state === MediaPlayerState.PLAYING,
          };
        }
        send(VoiceAssistantEvent.INTENT_START);
        send(VoiceAssistantEvent.INTENT_END, [
          { name: "conversation_id", value: "" },
          { name: "continue_conversation", value: "0" },
        ]);
        send(VoiceAssistantEvent.TTS_START, [
          { name: "text", value: step.text },
        ]);
        send(VoiceAssistantEvent.TTS_END, [{ name: "url", value: step.url }]);
        return;
      case "error":
        send(VoiceAssistantEvent.ERROR, [
          { name: "code", value: errorCodes[step.error] },
          { name: "message", value: step.error },
        ]);
        return;
      case "done":
        send(VoiceAssistantEvent.RUN_END);
        return;
    }
  }

  async function follow(run: VoiceRun) {
    try {
      for await (const step of run.steps()) {
        if (current !== run || gone) return;
        show(step, run);
      }
      if (current === run) current = null;
      await run.close("done");
    } catch (error) {
      options.log(`a voice run ended early (${String(error)})`);
      if (current === run) {
        current = null;
        send(VoiceAssistantEvent.RUN_END);
      }
      await run.close("done").catch(() => undefined);
    } finally {
      if (playback?.run === run) playback = null;
    }
  }

  async function start(wakeWord: string | null) {
    // A newer request takes over from one still under way.
    const opening = Symbol();
    pending = opening;
    const older = current;
    current = null;
    if (older) void older.close("stopped").catch(() => undefined);
    if (!options.listens) {
      pending = null;
      decline();
      return;
    }
    let run: VoiceRun | RefusedRun;
    try {
      run = await options.listen(wakeWord);
    } catch (error) {
      options.log(`a voice request couldn't open (${String(error)})`);
      if (pending === opening) {
        pending = null;
        decline();
      }
      return;
    }
    if (pending !== opening) {
      if (run.accepted) {
        await run
          .close(gone ? "disconnected" : "stopped")
          .catch(() => undefined);
      }
      return;
    }
    pending = null;
    if (!run.accepted) {
      decline();
      return;
    }
    current = run;
    requests.respondToRequest();
    send(VoiceAssistantEvent.RUN_START);
    send(VoiceAssistantEvent.STT_START);
    void follow(run);
  }

  const request = client.on("voiceAssistantRequest", (asked) => {
    if (!asked.start) {
      // The device stopped it itself, as with a press of its button.
      const run = current;
      const hadRequest = pending !== null || run !== null;
      pending = null;
      current = null;
      if (hadRequest) send(VoiceAssistantEvent.RUN_END);
      if (run) void run.close("stopped").catch(() => undefined);
      return;
    }
    if (asked.wakeWordPhrase) options.heard();
    void start(asked.wakeWordPhrase ?? null);
  });
  const audio = client.on("voiceAssistantAudio", (chunk) => {
    if (chunk.data.byteLength > 0) current?.send(chunk.data);
  });
  const telemetry =
    player &&
    client.on("telemetry", (event) => {
      if (
        !playback ||
        current !== playback.run ||
        event.type !== "media_player" ||
        event.key !== player.key
      )
        return;
      if (
        event.state === MediaPlayerState.ANNOUNCING ||
        (!playback.wasPlaying && event.state === MediaPlayerState.PLAYING)
      ) {
        playback.started = true;
      } else if (playback.started) {
        const { run } = playback;
        playback = null;
        void run.close("played").catch((error: unknown) => {
          options.log(
            `a voice run couldn't close after playback (${String(error)})`,
          );
        });
      }
    });
  const lifecycle = client.on("lifecycle", (event) => {
    if (event.kind !== "disconnect") return;
    gone = true;
    pending = null;
    const run = current;
    current = null;
    if (run) void run.close("disconnected").catch(() => undefined);
    request[Symbol.dispose]();
    audio[Symbol.dispose]();
    telemetry?.[Symbol.dispose]();
    lifecycle[Symbol.dispose]();
  });
  requests.subscribe(
    options.listens
      ? VoiceAssistantSubscribeFlag.API_AUDIO
      : VoiceAssistantSubscribeFlag.NONE,
  );
}
