---
title: Adding and removing apps
description: Add an app, turn one off for a while, remove one, and what happens to its data.
sidebar:
  order: 2
---

## Adding an app

1. Open **Settings**. Under **Add apps**, choose **Add** beside the app you
   want.
2. The sheet shows what the app adds to your home, how much memory it can
   use and the permissions it needs or asks to start with, together with
   the reason for each.
3. Choose **Add** followed by the app's name, such as **Add Weather**. Its
   settings open so you can see whether it's running.

**Add apps** doesn't show when your home already has every app.

### When an app can't be added

The sheet says why, and what would help:

- **It needs a newer Sanctum.** Update Sanctum in Settings → System, then
  add the app.
- **Its pages were made for an older Sanctum.** Update Sanctum to get a
  newer version of the app.
- **There isn't room for it.** The app needs more memory than is available.
  Turning off an app you don't use can make room.
- **There isn't space for it.** The app's data won't fit on the disk.
  Settings → System → Status shows what is using the space.

### Zigbee and ESPHome

You don't have to look for these two:

- **Zigbee.** If the Zigbee app isn't installed, plugging a supported stick
  into Sanctum's computer brings up an offer on connected devices in your
  home. Choose **Add Zigbee** or **Cancel**. If someone cancels the offer,
  it closes on every device and stays closed while the stick stays plugged
  in. You can still add Zigbee from **Settings** under **Add apps**.
- **ESPHome.** If the ESPHome app isn't installed, Sanctum can offer it
  when it finds ESPHome devices on your network. In **Add devices**, the
  **ESPHome** card says how many it found, such as "2 ESPHome devices found".
  Choose **Add ESPHome** on the card, then **Add ESPHome** in the sheet.
  Sanctum takes you to **Devices found**, where you can add the devices as
  the app finds them. If ESPHome is already running, choose **Devices found**
  directly in **Add devices**.

## Turning an app off

Turning an app off stops it for a while, without removing it. Open its
settings and, at the end of the page, choose **Turn off** with the app's
name, such as **Turn off Weather**. Sanctum first says what will go, for
example that the app's card leaves Home or that its devices go offline.

While it's off, the app uses no memory. Everything it had stays, so
choosing **Turn on** brings it all back.

## Removing an app

Open the app's settings and choose **Remove** followed by its name, such
as **Remove Zigbee**, at the end of the page. Before you confirm, Sanctum
says what goes with the app:

- The devices it brought in, such as every Zigbee light for the Zigbee app.
- Its cards on Home, and what it shows in rooms.
- Any active automations that use it, which turn off and say the app is
  missing.

Moods is part of Sanctum, so it can't be removed or turned off.

### Its data is kept for 30 days

After you remove an app, Sanctum keeps its data for 30 days. If you add the
app back within that time, it gets back its settings and the permissions
you chose. For Zigbee or ESPHome, its devices come back with their rooms
and history. Automations that removal turned off can turn back on by
themselves if they still have everything they need and nobody changed them.

Under **Add apps**, a removed app shows the date until which its data is
kept. To delete it sooner, choose the button under the app, such as
**Delete Zigbee's data now**. This can't be undone, so Sanctum asks first.
Adding the app back afterwards starts it from scratch.

Deleting an app's data also removes the devices it brought in, so if you
add the app back, add its devices again. When Zigbee's data
is deleted, now or once its 30 days are over, the Zigbee network is erased
too, unless another app still uses it. If the network is erased, you also
have to pair every Zigbee device again.
