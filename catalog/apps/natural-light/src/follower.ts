import type { AppContext } from "@meetsanctum/app-sdk";

import {
  followAll,
  followOptionsFor,
  publishAll,
  type RunForLight,
  type Timing,
} from "./lights.js";

// What natural light does while it runs, beside its job and its actions. Its
// start publishes where each light that follows the curve stands, from its
// own database, since that's how a failed update of it is undone; the job
// then sets them. A new curve reaches the lights at once, rather than at the
// next check: settings.changed wakes a loop the start began, since work
// launched by a handler loses its access to the core as soon as that handler
// returns.

export function createFollower(
  ctx: AppContext,
  timing: Timing,
  runForLight: RunForLight,
) {
  let isStopped = false;
  let isAskedAgain = false;
  let wake: (() => void) | undefined;

  // Every light to the curve as it stands now, those it set a moment ago too.
  async function takeNewCurve() {
    const options = await followOptionsFor(ctx, timing);
    await followAll(ctx, { ...options, isDueNow: true }, runForLight);
  }

  async function run() {
    while (!isStopped) {
      // One at a time: a change meanwhile runs right after.
      if (!isAskedAgain) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
      if (isStopped) return;
      isAskedAgain = false;
      try {
        await takeNewCurve();
      } catch (error) {
        if (!isStopped) {
          ctx.log(
            `could not take the new curve (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
    }
  }

  return {
    async start() {
      await ctx.events.on("settings.changed", () => {
        isAskedAgain = true;
        wake?.();
      });
      await publishAll(ctx, await followOptionsFor(ctx, timing), runForLight);
      void run();
    },
    /** After the core restarted: all it owns, said again for the home now. */
    async resume() {
      await publishAll(ctx, await followOptionsFor(ctx, timing), runForLight);
    },
    stop() {
      isStopped = true;
      wake?.();
    },
  };
}
