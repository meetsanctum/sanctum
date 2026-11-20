---
title: Permissions
description: What apps ask to do, when they ask, and how to change your answer.
sidebar:
  order: 3
---

An app can only do what your home allows it to. Each thing it may do is a
**permission**, such as "Control your lights" or "Know where your home is".
Sanctum words every permission the same way for every app, and the app adds
its reason: Weather, for example, asks to know where your home is "to fetch
the forecast and sun times for where you live".

## Needed and optional

Some permissions an app can't work without. These are marked **Needed**,
and adding the app allows them. The sheet you see before adding an app
lists them.

Others are optional. An app asks for an optional permission the first time
you use what needs it. Moods, for example, asks to know when there's motion
when you first turn on lights for motion. Choose **Allow** to give it, or
**Not now** to leave things as they are. Not now isn't remembered, so the
app asks again next time.

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

| Permission                                  | What it lets the app do                                     |
| ------------------------------------------- | ----------------------------------------------------------- |
| See your rooms                              | Read your home's rooms                                      |
| Know where your home is                     | Read the position you set for your home                     |
| See your lights, switches or sensors        | Read whether they're on, or what they measure               |
| Control your lights or switches             | Turn them on and off, dim them and change their colour      |
| See your remotes' presses                   | Know when someone presses a remote's button                 |
| Know when there's motion                    | Read your motion sensors                                    |
| Bring devices into your home                | Add devices, as Zigbee and ESPHome do                       |
| Find or talk to devices on your network     | Reach devices on your home network, as ESPHome does         |
| Keep its own automations                    | Make automations of its own, as Moods does for your remotes |
| Reach a website, such as api.open-meteo.com | Use that website, and no other, as Weather does             |

An app reaches only the websites it names. Weather sends only your home's
position, to fetch the forecast.
