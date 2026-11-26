---
title: Effects and motion
description: Draw Sanctum more plainly on one device, for a screen that feels slow or for less movement.
sidebar:
  order: 1
---

Every device that shows Sanctum has two switches, **Reduce effects** and
**Reduce motion**. They change how Sanctum is drawn on that one device. They
never change what it shows or what you can do: the same rooms, devices and
buttons are in the same places either way.

Both are off until someone turns them on. Each one works on its own, so you
can turn on one, the other or both.

## Reduce effects

Removes frosted blur, edge fades and soft shadows. This makes a slow device
faster. A wall display, such as Shelly's, usually needs it.

With Reduce effects on:

- Tiles and cards keep their colour, without the frosted blur behind them.
- A row that fades out at its edge stops there instead.
- Things that float, such as the sidebar, keep their thin outline but lose
  their soft shadow.
- A light or another device opens and closes at once, without fading in.

## Reduce motion

Cuts down on sliding, zooming and other movement. This is for anyone who'd
rather see less movement, and it also helps a slow device.

With Reduce motion on:

- Tabs change the page in place.
- The colour picker's circles appear in place, without flying out.
- Sanctum's loader breathes instead of drawing its line.

Pages you swipe with your finger or drag with the mouse still slide the
rest of the way when you let go, so they don't jump.

Sanctum doesn't follow a device's own reduce motion or reduce transparency
setting. To have less movement in Sanctum, turn on Reduce motion here.

## Turning them on

1. Open **Settings → Clients**, on any device.
2. Press **⋮** beside the device you want to change.
3. Choose **Effects and motion**, then switch **Reduce effects** or
   **Reduce motion** on or off.

Any device can change any other's, so you can set a wall display from your
computer without touching it. Its row in Clients shows the saved settings,
such as "Reduced effects and motion". A device with a live connection
applies the change right away. Otherwise, it applies the change the next
time it checks for updates, such as when it reconnects.

Apps' pages follow the same two switches on each device.

If the dialog says to update Sanctum in your home instead, the Mac app is
newer than Sanctum. [Update it](/install/updating/) and the switches appear.
