---
title: Updates and problems
description: How apps update with Sanctum, when an update waits, going back, and what to do when an app isn't running.
sidebar:
  order: 4
---

## How apps update

Apps update with Sanctum. When you
[update Sanctum](/install/updating/), its apps move to their new versions
one at a time. While an app updates, its settings say "Updating to" and the
new version, and it starts again by itself.

If a new version doesn't start, the app goes back to the version it had and
keeps everything it had saved. Its settings say so, for example "Version
0.4.0 didn't start, so it's back on 0.3.0".

## When an update waits

Sometimes an app stays on the version it has, and its settings say the new
one is waiting:

- **The new version needs a new permission.** For example, it now wants to
  control your switches. Nothing changes until someone agrees. Choose
  **Review** in the app's settings: it shows only what's new. **Update**
  allows it and starts the update. **Not now** leaves the app as it is.
- **The new version needs more memory than is left.** The settings say how
  much more, such as "It needs 64 MB more memory". Turning off an app you
  don't use makes room, and the update then starts by itself within a
  minute.

Settings → Needs attention lists every app with an update waiting.

## Going back after an update

If an app's last update doesn't suit you, open its settings and choose
**Go back** at the end of the page. The app returns to the version before,
with its data as it was on the day of the update. Anything it saved since
is lost, so Sanctum asks first. The app then stays on that version until a
newer one arrives.

Go back is there until the app's next update.

## When an app isn't running

An app that isn't running stays on your screens, dimmed, and says why. Its
settings say the most, with **How it's running** near the end: its memory,
its restarts and the last thing that went wrong.

| What it says                                        | What to do                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Starting, or Restarting                             | Nothing. It starts by itself, usually within seconds.                          |
| Waiting for Zigbee2MQTT, or for Sanctum             | Nothing. It starts once what it waits for is ready.                            |
| Paused                                              | Turn the [needed permission](/apps/permissions/#changing-your-answer) back on. |
| Off                                                 | Choose **Turn on** if you want it back.                                        |
| Stopped after 5 failures in 10 minutes              | Choose **Restart**. If it keeps stopping, the reason under it says why.        |
| Not running · it starts again when Sanctum restarts | It didn't stop cleanly. Restart Sanctum from Settings → Status.                |

Each app has a limit on the memory it uses. One that goes over it restarts,
and its settings say "It ran out of memory". Only that app restarts, never
the rest of your home.
