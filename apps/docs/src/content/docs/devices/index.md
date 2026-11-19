---
title: How Sanctum sees a device
description: A device is made of parts that each do one thing, and its type says what the whole device is.
sidebar:
  order: 1
---

Sanctum looks at every device in two ways: by its **parts**, the things it
can do, and by its **type**, what the whole device is. Parts decide what you
can do with a device. Its type decides what it is called and where it sits on
a room's page.

## Parts

Each part of a device does one thing. Sanctum knows six:

| Part    | What it does                                             |
| ------- | -------------------------------------------------------- |
| Light   | Turns on and off, and may dim or change colour           |
| Switch  | Turns something on and off                               |
| Sensor  | Measures one thing: temperature, humidity or light level |
| Motion  | Says whether something is moving                         |
| Contact | Says whether something is open or closed                 |
| Button  | Is pressed                                               |

A device can have several parts, and several of the same part. A ceiling
light is one light. A wall module with two relays is two switches. A sensor
that measures temperature and humidity is two sensors, one for each.

[What each part does](/devices/parts/) has the details of each.

## Types

A device's type is what the whole device is, such as a light or a motion
sensor. The driver chooses it based on what it knows about the device. A
light can still be a light if it also measures temperature. The household
can choose to show a contact sensor as a door or window.

[Device types](/devices/types/) lists every type, what it needs and what
it is called.

## One device, followed through

Take a motion sensor that also measures the light level, in the Office:

- **Its parts** are a motion part and a sensor part for the light level.
- **Its type** is motion sensor, so Sanctum names it "Office Motion Sensor".
- **On the Office's page** it is one tile under Presence, saying "Quiet for 5
  min" or "Motion now".
- **In the categories**, it is under Presence for its motion and under
  Environment for its light level, since each category gathers every part
  that fits it.
- **Opened**, it shows its Motion, Readings and Activity pages, one tab
  each.

[Categories](/devices/categories/) explains where devices show.

## Where devices come from

Sanctum doesn't talk to devices itself. Apps called drivers do: Zigbee for
Zigbee lights, sensors and remotes, ESPHome for devices that run ESPHome.
A driver tells Sanctum each device's parts and its type, and Sanctum checks
that the device has the parts that type needs.
[For driver apps](/devices/drivers/) has what a driver says and what
Sanctum checks.
