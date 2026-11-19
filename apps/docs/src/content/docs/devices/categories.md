---
title: Categories
description: The six categories that gather devices' parts, and how a room's page shows each device once.
sidebar:
  order: 3
---

Categories gather what's alike across the home: every light, every
sensor's reading, every door. Sanctum has six, and each holds one kind of
part:

| Category    | Id            | Holds         | Its page also has                              |
| ----------- | ------------- | ------------- | ---------------------------------------------- |
| Lights      | `lights`      | Light parts   | How many are on, with **Turn all off**         |
| Switches    | `switches`    | Switch parts  | How many are on                                |
| Environment | `environment` | Sensor parts  | A summary of the home's readings               |
| Presence    | `presence`    | Motion parts  | An overview of the last 24 hours, room by room |
| Security    | `security`    | Contact parts | A summary of what is open                      |
| Buttons     | `buttons`     | Button parts  | Nothing more                                   |

The sidebar lists them in this order, under Categories, and only those with
at least one part in them. A category's page groups its parts by room.

## A device shows in every category it fits

A category holds parts, not devices. So a device with parts of two kinds
shows in two categories: a motion sensor that measures the light level is
under Presence for its motion and under Environment for its light level.
That keeps each category complete, so Environment's summary counts every
temperature in the home, whichever device measures it.

Home and the home's status work the same way, part by part.

## A room's page shows each device once

A room's page has a section for each category, in the same order, then
Unknown devices for devices Sanctum can't use. There, each device has one
tile, in the section of its [type](/devices/types/):

| Device                                           | Its one tile      |
| ------------------------------------------------ | ----------------- |
| A light with a button and a temperature sensor   | Under Lights      |
| A motion sensor that measures the light level    | Under Presence    |
| A contact sensor, shown as a door, that measures | Under Security    |
| A sensor that also switches a relay              | Under Environment |

The tile says the device's main state only, since the room's readings
already sit under its name:

| Type                         | Its tile says                                                              |
| ---------------------------- | -------------------------------------------------------------------------- |
| Light                        | Its brightness, such as "80%", "On" for a light that doesn't dim, or "Off" |
| Plug and switch              | "On" or "Off"                                                              |
| Button                       | "Idle", or the press for a moment after one                                |
| Motion sensor                | "Motion now", or "Quiet for 5 min"                                         |
| Contact sensor, door, window | "Closed", or "Open for 12 min"                                             |
| Sensor                       | Its readings                                                               |
| Unknown device               | The name its driver gives it                                               |

A device that doesn't answer says "Offline" whatever its type.

Pressing the tile turns the device's light or switch on or off, where it
has one. A device with more than one light or switch keeps a tile for each
of the others, named by its part: a module with two relays has two tiles.

Only a button's tile lights up when it is pressed. A light that has a
button goes on showing whether the light is on.

## Opening a device

Opening a device shows all of its parts, one page each, in this order:

1. its light's or switch's controls;
2. Motion;
3. Contact;
4. Readings;
5. pages that apps add, such as the presses a remote has made;
6. its light's or switch's History;
7. Activity: what the device did, and what was done to it.

It has only the pages its parts call for: a plain bulb has its controls,
History and Activity. The pages are the same whichever tile opened the
device. It opens on the page of that tile: a room's tile opens the first
page, and the device's temperature under Environment opens Readings. When
there are more tabs than fit, they scroll sideways.
