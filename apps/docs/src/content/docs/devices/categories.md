---
title: Categories
description: The seven categories that gather devices' parts, and how a room's page groups tiles by device.
sidebar:
  order: 3
---

Categories gather what's alike across the home: every light, every
sensor's reading, every door. Sanctum has seven, and each holds one kind
of part:

| Category    | Id            | Holds         | Its page also has                              |
| ----------- | ------------- | ------------- | ---------------------------------------------- |
| Lights      | `lights`      | Light parts   | How many are on, with **Turn all off**         |
| Environment | `environment` | Sensor parts  | Ranges for temperature and humidity            |
| Security    | `security`    | Contact parts | A summary of what is open                      |
| Presence    | `presence`    | Motion parts  | An overview of the last 24 hours, room by room |
| Switches    | `switches`    | Switch parts  | How many are on                                |
| Media       | `media`       | Media parts   | How many TVs, speakers and others are playing  |
| Buttons     | `buttons`     | Button parts  | Nothing more                                   |

The sidebar lists them in this order, under Categories, and only those with
at least one part in them. Beside the name, categories with a status tile
on Home show the same status, such as "2 on" or "19.5–21.5°".
Buttons shows only its name. Presence names one room with motion or shows
a count such as "2 rooms" when several rooms have motion. A category's
page groups its parts by room. Parts from unassigned devices in the
category appear under **No room**.

## A device shows in every category it fits

A device with parts of two kinds shows in two categories. A motion sensor
that measures the light level is under Presence for its motion and under
Environment for its light level. Environment shows a device's sensor
readings together on one tile.

Home also shows the parts of any device you add to it. The status at the
top of Home summarises temperature or humidity, motion, contacts, lights,
switches and how many media players are playing across the home, including
devices you haven't added to Home.

## A room's page groups tiles by device

A room's page lists the categories in the same order, with **Unknown
devices** last if the room has any. Each device has a main tile in the
section for its [type](/devices/types/). Extra lights or switches on the
same device get their own tiles.

| Device                                                          | Main tile         |
| --------------------------------------------------------------- | ----------------- |
| A light with a button and a temperature sensor                  | Under Lights      |
| A motion sensor that measures the light level                   | Under Presence    |
| A contact sensor shown as a door that also measures temperature | Under Security    |
| A device registered as a sensor that also switches a relay      | Under Environment |

The main tile shows the state for the device's type. A summary of the
room's readings sits under the room name.

| Type                         | Its tile says                                                              |
| ---------------------------- | -------------------------------------------------------------------------- |
| Light                        | Its brightness, such as "80%", "On" for a light that doesn't dim, or "Off" |
| Plug and switch              | "On" or "Off"                                                              |
| Button                       | "Idle", or the press for a moment after one                                |
| Motion sensor                | "Motion now", or "Quiet for 5 min"                                         |
| Contact sensor, door, window | "Closed", or "Open for 12 min"                                             |
| Media player, TV, speaker    | "Playing · The News", "Paused", "On · TV", "Off" or "Not playing"          |
| Sensor                       | Its readings                                                               |
| Unknown device               | The name its driver gives it                                               |

A tile says "Offline" when the device is marked offline, or "Not paired"
if the device has left its network. Some battery-powered devices that have
gone quiet say "Not heard from". A light or switch that doesn't confirm a
change says "Not responding".

On a tile that can switch something on or off, press the round icon to
toggle it. On a media player's tile, the icon plays or pauses where the
player supports it. Press the rest of the tile to open the device. Each
extra light or switch has a tile named after its part, so a module with two
relays has two tiles.

Only a button's tile lights up when it is pressed. A light that has a
button goes on showing whether the light is on.

## Opening a device

Opening a device shows the tabs that apply to it, in this order.

1. Light or switch controls. A light can have **Colour** or **White**
   followed by **Brightness**, depending on its features. **Power** appears
   when neither control applies.
2. **Playing**, what a media player plays, with its playback controls and
   position. Press Space on this tab to play or pause. A player with power
   controls also has **Remote**, with power above any volume steps. Other
   players with volume or mute controls have them under **Volume**.
3. **Motion**.
4. **Contact**, **Door** or **Window**, depending on how the device is shown.
5. **Readings**, with all the device's sensor readings.
6. Content from apps, such as a remote's **Presses**. Multiple app pages
   share a **From apps** tab.
7. **History** for the light or switch whose controls are shown.
8. **Activity**, with what the device did and what was done to it.

A room tile opens the first tab. A category tile opens the tab for its
part. For example, a sensor tile under Environment opens **Readings**, and
a tile under Buttons opens the relevant app page or **Activity**. If you
open an extra light or switch, the controls and **History** are for that
part. When there are more tabs than fit, they scroll sideways.
