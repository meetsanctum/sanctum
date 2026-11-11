import {
  pressCaptureDurationMs,
  pressParts,
  type LivePress,
  type PressCapture,
} from "@meetsanctum/app-sdk";

import type { CoreBridge } from "./client";

// A remote's presses on screen: what to call each of its actions, its
// presses by button, and capturing the next presses while someone picks one,
// as binding a button to a mood or choosing a press trigger does.
// Ported from v1's formatButtonAction (button-action-common.ts) and
// useButtonActionCapture (Pragmata v1-final), in sentence case.

// What the common actions are called, alone or after a button's number.
const common = new Map([
  ["click", "Single press"],
  ["single", "Single press"],
  ["double", "Double press"],
  ["triple", "Triple press"],
  ["quadruple", "Quadruple press"],
  ["hold", "Hold"],
  ["long", "Long press"],
  ["on", "On"],
  ["off", "Off"],
]);

/**
 * What to call one of a remote's actions, such as "Single press" for
 * single, "On press" for on_press or "1 double press" for button_1_double.
 */
export function pressLabel(action: string) {
  const words = action
    .replace(/^button_(\d+)_/, "$1_")
    .split(/[_\s-]+/)
    .filter(Boolean);
  const [first = action, second] = words;
  if (/^\d+$/.test(first) && second && words.length === 2) {
    return `${first} ${(common.get(second) ?? second).toLowerCase()}`;
  }
  const label = common.get(first);
  if (words.length === 1 && label) {
    return label;
  }
  const text = words.join(" ").toLowerCase();
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** What to call one of a remote's buttons, such as "Up button" or "Button 1". */
export function buttonLabel(button: string) {
  const words = button
    .replace(/^button_/, "")
    .split(/[_\s-]+/)
    .filter(Boolean);
  if (words.length === 1 && /^\d+$/.test(words[0]!)) {
    return `Button ${words[0]}`;
  }
  const text = words.join(" ").toLowerCase();
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} button`;
}

/** One of a remote's buttons, by its label, with its presses; none named on a remote with one. */
export type PressGroup = {
  button: string | null;
  presses: { action: string; label: string }[];
};

/**
 * A remote's presses by button, where it names more than one, such as a
 * Hue dimmer's on, up, down and off buttons, each with its press and hold.
 * A remote with one button, or whose actions name none, is one group.
 */
export function pressGroups(actions: readonly string[]): PressGroup[] {
  const buttons = new Set(actions.map((action) => pressParts(action).button));
  if (buttons.size < 2 || buttons.has(null)) {
    return [
      {
        button: null,
        presses: actions.map((action) => ({
          action,
          label: pressLabel(action),
        })),
      },
    ];
  }
  const groups = new Map<string, PressGroup>();
  for (const action of actions) {
    const { button, press } = pressParts(action);
    const group = groups.get(button!) ?? {
      button: buttonLabel(button!),
      presses: [],
    };
    group.presses.push({ action, label: pressLabel(press) });
    groups.set(button!, group);
  }
  return [...groups.values()];
}

/**
 * A press as its own page names it among its remote's: "Up button, hold"
 * where the remote has several buttons, "Double press" where it has one.
 */
export function pressTitle(action: string, groups: readonly PressGroup[]) {
  for (const group of groups) {
    const press = group.presses.find((each) => each.action === action);
    if (press) {
      return group.button
        ? `${group.button}, ${press.label.toLowerCase()}`
        : press.label;
    }
  }
  return pressLabel(action);
}

export type PressCaptureListener = {
  /** A press of the remote, which no workflow or app heard. */
  press(press: LivePress): void;
  /**
   * The capture ended without being stopped: after five minutes, or when
   * it could not start or the core no longer held it, as after a restart,
   * which a press reaching workflows shows. Start another to go on. Also reports failure
   * to release a capture whose start completed after it was stopped;
   * this can report another failure after a reconnect ended the capture.
   */
  ended?(reason: "expired" | "failed"): void;
};

/**
 * Captures a remote's presses until it is stopped, for five minutes at
 * most: the core holds them back from workflows and apps meanwhile, and
 * each reaches the listener instead. Every client may, shared ones too.
 * For an app's page, the capture is the app's too, and ends when the app
 * pauses or may no longer read remotes' buttons.
 */
export function capturePresses(
  bridge: Pick<CoreBridge, "json" | "live">,
  device: string,
  listener: PressCaptureListener,
  app?: string,
) {
  let capture: PressCapture | undefined;
  let pendingPress: LivePress | undefined;
  let isStopped = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const requestedAt = performance.now();
  // Only presses the core held back: before it has, they reached
  // workflows too.
  const unsubscribe = bridge.live.subscribe({
    message(message) {
      if (!isStopped && message.type === "press" && message.device === device) {
        if (!capture) {
          // The live event may beat the HTTP start response. Keep the
          // latest suppressed press until we know this capture's lifetime.
          if (message.isCaptured) pendingPress = message;
          return;
        }
        // Browser timers can be delayed while a tab sleeps. Both times
        // here come from the core, so its expiry still wins.
        if (Date.parse(message.at) >= Date.parse(capture.until)) {
          end("expired");
          return;
        }
        // The WebSocket may deliver an earlier, uncaptured press after
        // the HTTP start response. Only the core knows it was suppressed.
        if (message.isCaptured) {
          listener.press(message);
        } else if (
          Date.parse(message.at) >=
          Date.parse(capture.until) - pressCaptureDurationMs
        ) {
          // One from after the capture began reached workflows: the core
          // no longer holds it, as after a restart. A refresh of the live
          // feed, which the shell makes every so often, says nothing of
          // that, so it ends nothing.
          end("failed");
        }
      }
    },
  });

  function end(reason: "expired" | "failed") {
    if (isStopped) return;
    isStopped = true;
    pendingPress = undefined;
    clearTimeout(expiry);
    unsubscribe();
    // The local deadline counts request time too, so it may precede the
    // server's expiry. Release any remaining suppression.
    if (capture) void release(capture.id).catch(() => undefined);
    listener.ended?.(reason);
  }

  async function release(id: string) {
    await bridge.json("/api/devices/capture/stop", {
      method: "POST",
      json: { id },
    });
    if (capture?.id === id) capture = undefined;
  }

  void bridge
    .json<PressCapture>("/api/devices/capture/start", {
      method: "POST",
      json: { device, ...(app && { app }) },
    })
    .then(
      (started) => {
        if (isStopped) {
          capture = started;
          // Reconnect may already have reported an end before we knew
          // the capture id. Report this separate cleanup failure too,
          // so the caller can retry stop now that the id is available.
          void release(started.id).catch(() => listener.ended?.("failed"));
          return;
        }
        capture = started;
        expiry = setTimeout(
          () => end("expired"),
          // The two machines' clocks need not agree. Count elapsed time
          // against their shared lifetime, including the start request.
          Math.max(
            0,
            pressCaptureDurationMs - (performance.now() - requestedAt),
          ),
        );
        if (pendingPress) {
          const at = Date.parse(pendingPress.at);
          const until = Date.parse(started.until);
          if (at >= until - pressCaptureDurationMs && at < until) {
            listener.press(pendingPress);
          }
          pendingPress = undefined;
        }
      },
      () => {
        if (!isStopped) end("failed");
      },
    );

  return {
    /** Ends the capture. A failed release rejects and can be retried. */
    async stop() {
      isStopped = true;
      pendingPress = undefined;
      clearTimeout(expiry);
      unsubscribe();
      if (capture) {
        await release(capture.id);
      }
    },
  };
}
