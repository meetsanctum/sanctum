---
title: Adding and removing apps
description: Add an app, turn one off for a while, remove one, and what happens to its data.
sidebar:
  order: 2
---

## Adding an app

1. Open **Settings**. Under **Add apps**, choose **Add** beside the app you
   want.
2. A sheet shows what the app needs to work, with its reason for each, what
   it adds to your home and how much memory it uses.
3. Choose **Add**. The app starts, and its settings open.

**Add apps** doesn't show when your home already has every app.

### When an app can't be added

The sheet says why, and what would help:

- **It needs a newer Sanctum.** Update Sanctum in Settings → System, then
  add the app.
- **There isn't room for it.** Your other apps are using the memory it
  needs. Turning off an app you don't use makes room.
- **There isn't space for it.** The app's data won't fit on the disk.
  Settings → Status shows what is using the space.

### Zigbee and ESPHome

You don't have to look for these two:

- **Zigbee.** Plug a Zigbee stick into Sanctum's computer, and Sanctum
  offers to add the Zigbee app on every open device. Choose **Add**, or
  **Cancel** if you don't want it.
- **ESPHome.** When ESPHome devices are on your network, **Add devices**
  shows a card such as "2 ESPHome devices found". Press it to add the
  ESPHome app. Once the app is in, your devices show under Devices found.

## Turning an app off

Turning an app off stops it for a while, without removing it. Open its
settings and, at the end of the page, choose **Turn off** with the app's
name, such as **Turn off Weather**. Sanctum first says what will go, for example that the app's card leaves Home or that its
devices go offline.

While it's off, the app uses no memory. Everything it had stays, so
choosing **Turn on** brings it all back.

## Removing an app

Open the app's settings and choose **Remove** at the end of the page. Before
you confirm, Sanctum says what goes with the app:

- The devices it brought in, such as every Zigbee light for the Zigbee app.
- Its cards on Home, and what it shows in rooms.
- The automations that use it. These turn off and say the app is missing.

Moods is part of Sanctum, so it can't be removed or turned off.

### Its data is kept for 30 days

After you remove an app, Sanctum keeps its data for 30 days. If you add the
app back within that time, it picks up where it left off: its settings, and
for Zigbee or ESPHome its devices, with their rooms and history.

Under **Add apps**, a removed app says until when its data is kept. To
delete it sooner, choose the button under the app, such as **Delete
Zigbee's data now**. This can't be
undone, so Sanctum asks first. Adding the app back afterwards starts it from
scratch. For Zigbee, it also erases the Zigbee network, unless another app
still uses it, so every Zigbee device has to be paired again.
