---
title: Permissions
description: What apps ask to do, when they ask, and how to change your answer.
sidebar:
  order: 3
---

An app can only do what your home allows it to. Each thing it may do is a
**permission**, such as "Control your lights" or "Know where your home is".
Sanctum words every permission the same way for every app, and the app adds
its reason. For example, Weather asks to know where your home is. Its
reason is "To fetch the forecast and sun times for where you live."

## Needed and optional

Some permissions an app needs to work. These are marked **Needed** in its
settings. The sheet shows them before you add the app, and adding it allows
them.

The sheet also lists any optional permissions that start on. For example,
Natural light starts with **See your rooms**. You can switch it off in the
app's settings.

When a feature needs a permission that's off, the app can ask as you try
to use it. For example, Moods asks to know when there's motion when you
turn on lights for motion. Choose **Allow** to give it, or **Not now** to
leave things as they are. If you choose **Not now**, it can ask again next
time.

## Changing your answer

**Settings → Apps → the app** lists its permissions, each with a switch.
Anyone in the household can switch any of them, from any device.

- **Turning off an optional permission** takes it away at once. The app
  keeps working without that one thing.
- **Turning off a needed permission** pauses the app, so Sanctum asks first.
  A paused app says what it needs, such as "Paused · it needs “Control your
  lights”", and starts again by itself once you turn the permission back
  on.

## What apps may ask for

| Permission                      | What it lets the app do                                     |
| ------------------------------- | ----------------------------------------------------------- |
| See your rooms                  | Read your home's rooms                                      |
| Know where your home is         | Read the location you set for your home                     |
| See what your sensors read      | Read measurements, such as how bright a room is             |
| Control your lights             | Turn lights on and off, dim them and change their colour    |
| See your remotes' presses       | Know when someone presses a remote's button                 |
| Know when there's motion        | Read your motion sensors                                    |
| Bring devices into your home    | Add devices, as Zigbee and ESPHome do                       |
| Use Zigbee2MQTT                 | Reach your Zigbee devices through the stick                 |
| Find devices on your network    | Discover devices on your home network, as ESPHome does      |
| Talk to devices on your network | Reach the devices it found                                  |
| Keep its own automations        | Make automations of its own, as Moods does for your remotes |
| Reach api.open-meteo.com        | Reach Open-Meteo for the forecast, as Weather does          |

Each website has its own permission. Weather sends your home's position
and time zone to Open-Meteo to fetch the forecast.
