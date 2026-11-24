---
title: For driver apps
description: What a driver app tells Sanctum about each device, how it picks the device's type, and what Sanctum checks.
sidebar:
  order: 5
---

A driver is an app that brings devices in, such as Zigbee or ESPHome. It
talks to the devices in their own language and tells Sanctum about each one
in Sanctum's: its parts and its type. This page is for whoever writes or
changes a driver.

## What a driver says about a device

A driver registers each device with `ctx.devices.register` and registers it
again when its registration details change. Use `ctx.devices.report`
for changes in availability, part state or battery level.

- **`key`** is the driver's stable id for the device.
- **`name`** is the device's own name or a description such as its model.
  Sanctum keeps it alongside the [household's device name](/devices/types/#names).
- **`type`** is one of the [device types a driver can declare](/devices/types/#how-a-device-gets-its-type).
- **`capabilities`** lists the device's parts. Each has a unique `id`, a
  [`kind`](/devices/parts/) and any `features` it needs, such as whether a
  light dims.

The driver can also include `manufacturer`, `model` and `firmware`, and say
whether it can check the device's state (`probe`) or make it identify itself
(`identify`).

Registering again with the same driver and key updates the device. It keeps
its room and any name the household gave it. Its automatic name can change
with its type or what it measures. Sanctum keeps the household's
**Show as** choice and uses it whenever the registered type supports it.

## Picking the type

The driver picks the type, since it knows what the device says of itself.
When the protocol only tells you what parts the device has, pass their kinds
to `deviceTypeOf`. It uses the
[matching order](/devices/types/#how-a-device-gets-its-type) to pick a type.

A driver can declare `plug` for a device with a switch. The Zigbee driver
does this for a device with a switch and no light when its registered name
or model contains a word such as plug, outlet or socket. ESPHome also
requires a switch and no light. It uses `plug` if all its switches are
classed as outlets, or if none has a class and the name or model matches
the same words.

For a contact sensor, declare `contact`. The household can
[choose to show it as a door or window](/devices/types/#door-and-window).

Declare `smart-speaker` for a device with a microphones part (`audio`),
which is what makes it one, or `media-player` for another playback
device. The household can
[show a media player as a TV or a speaker](/devices/types/#tv-and-speaker).

## What Sanctum checks

Sanctum takes the driver's word for the type, as long as the device has the
part that type needs. A light must have a light part; a motion sensor a
motion part. An unknown device must have no parts at all: a device with
parts Sanctum can use is never unknown.

A registration that doesn't fit is refused, and the device isn't brought
in or updated. The driver gets an error saying that it registered a device
Sanctum can't take.

## Parts, the way Sanctum wants them

- **One thing per part.** A sensor that measures temperature and humidity
  is two sensor parts. A module with two relays is two switch parts.
- **IDs that read well after the device's name.** When a device has
  multiple light or switch parts, their tiles show the part ID after the
  name, for example "Hallway Switch left" and "Hallway Switch right".
  IDs use up to 32 lowercase letters, digits, hyphens or underscores and
  start with a letter or digit.
- **Standard units.** Report temperature in degrees Celsius, relative
  humidity in percent and light levels in lux. Convert the device's
  readings before reporting them if it uses other units.
- **Presses as they happen.** A button's presses go to `ctx.devices.press`,
  one call for each press, never as state. A hold ends with
  `ctx.devices.release` when the button is let go.
- **Pictures by their hash.** A media player's picture of what it plays goes
  to `ctx.blobs.put`, a still JPEG, PNG or WebP of up to 700 KB and 4096 px
  on each side. The call returns a hash the player reports as
  `media.artwork`. Resize oversized pictures and use a still frame from an
  animation. If there is no suitable picture, report what plays without
  `media.artwork` so the shell shows its own placeholder. The core keeps a
  picture in memory while any of that driver's device states name it and
  for a minute after the last one stops. Report the state that names a new
  picture within a minute of putting it. The core keeps at most 16 MB and
  128 pictures per driver and can drop the oldest unnamed pictures sooner to
  make room. Put a picture again when the driver starts or when it names a
  picture its devices stopped naming.

## In the code

The types, categories and parts are defined in `@meetsanctum/app-sdk`
(`packages/app-sdk/src`), which every driver builds on:

| File                     | Holds                                                   |
| ------------------------ | ------------------------------------------------------- |
| `device-types.ts`        | The types, what each needs, their names, `deviceTypeOf` |
| `device-categories.ts`   | The categories and the kind of part each holds          |
| `devices.ts`             | The parts: what each can do, says and is asked          |
| `device-registration.ts` | What a driver registers, and the check of its type      |
| `media.ts`               | The media part: what a player can do, says and is asked |
| `audio.ts`               | The microphones part: muting, and the wake word heard   |
| `blobs.ts`               | Pictures a driver hands over, and their limits          |

The Zigbee and ESPHome drivers, in `catalog/apps/zigbee` and
`catalog/apps/esphome`, show both ways of picking a type: by the parts, and
by what the device says of itself for a plug.
