---
title: Updates and problems
description: How apps update with Sanctum, when an update waits, going back, and what to do when an app isn't running.
sidebar:
  order: 4
---

## How apps update

App updates come with Sanctum. After you [update Sanctum](/install/updating/),
apps that have a new version and are ready to update do so one at a time.
Apps you turned off wait until you turn them on. While an app updates,
its settings say "Updating to" and the new version.

If a new version doesn't start and the previous version can still run on
this Sanctum, the app goes back and restores its saved data. Its settings
say so, for example "Version 0.4.0 didn't start, so it's back on 0.3.0".
If the previous version can't run here, the app stays on the new one, and
Sanctum keeps trying to start it, as
[When an app isn't running](#when-an-app-isnt-running) describes.

## When an update waits

When an update waits, the app's settings say what the new version needs.

- **The new version needs a permission you haven't granted.** Choose
  **Review** in the app's settings to see what it needs. If the app is
  still on its old version, choose **Update** to grant the permission
  and start the update. If the old version can't run on this Sanctum,
  the app stops until you choose **Allow**. **Not now** leaves the
  update waiting.
- **The new version needs more memory than is left.** The settings say how
  much more, such as "It needs 64 MB more memory". Turning off an app you
  don't use can make room. Sanctum checks for room every minute.

Settings → Needs attention lists every app with an update waiting.

## Going back after an update

If an app's last update doesn't suit you, open its settings and choose
**Go back to** and the version before, such as **Go back to 0.3.0**, at
the end of the page. Sanctum asks first because the app's data goes back to
how it was before the update, and anything else it saved since is lost.
Settings you've chosen stay where the previous version can use them.
Automations that use the app may need changing. The app stays on the
previous version until an update newer than the one you went back from
arrives.

Sanctum offers **Go back** while it has a copy of the previous version that
can still run here. The button is hidden while the app is off, paused,
starting or changing versions.

## When an app isn't running

An app's settings show why it isn't running. When an app stops unexpectedly,
its pages and cards dim if it stays down. Turning it off also takes its
cards off Home. In its settings, **How it's running** shows memory use and
restarts. A notice near the top says what went wrong when Sanctum knows.

| What it says                                        | What to do                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Starting, or Restarting                             | Give the app time. Sanctum starts it or tries again by itself.                 |
| Waiting for Zigbee2MQTT, or for Sanctum             | Nothing. It starts once what it waits for is ready.                            |
| Paused                                              | Turn the [needed permission](/apps/permissions/#changing-your-answer) back on. |
| Off                                                 | Choose **Turn on** if you want it back.                                        |
| Stopped after 5 failures in 10 minutes              | Choose **Restart**. If it keeps stopping, the reason under it says why.        |
| Not running · it starts again when Sanctum restarts | It didn't stop cleanly. Restart Sanctum from Settings → Status.                |

Each app has a limit on the memory it uses. One that goes over it restarts,
and its settings say "It ran out of memory". Only that app restarts, never
the rest of your home.
