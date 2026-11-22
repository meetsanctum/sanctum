---
title: Device types
description: Every type of device Sanctum knows, what each needs, what it is called and where it shows.
sidebar:
  order: 2
---

A device's type is what the whole device is. Sanctum knows the types below
and no others. A device that fits none of them is an unknown device.

## Every type

| Type           | Id              | What it is                                   | Needs   | Example name in the Office | On a room's page |
| -------------- | --------------- | -------------------------------------------- | ------- | -------------------------- | ---------------- |
| Light          | `light`         | A bulb, a strip, a lamp                      | Light   | Office Light               | Lights           |
| Plug           | `plug`          | A plug that switches what is plugged into it | Switch  | Office Plug                | Switches         |
| Switch         | `switch`        | A relay or wall switch                       | Switch  | Office Switch              | Switches         |
| Button         | `button`        | A remote or wall button                      | Button  | Office Button              | Buttons          |
| Motion sensor  | `motion`        | A sensor that sees movement                  | Motion  | Office Motion Sensor       | Presence         |
| Contact sensor | `contact`       | A sensor that says whether something is open | Contact | Office Contact Sensor      | Security         |
| Door           | `door`          | A contact sensor on a door                   | Contact | Office Door                | Security         |
| Window         | `window`        | A contact sensor on a window                 | Contact | Office Window              | Security         |
| Smart speaker  | `smart-speaker` | A voice-enabled speaker                      | Media   | Office Speaker             | Media            |
| Media player   | `media-player`  | A TV box, or anything else that plays        | Media   | Office Media Player        | Media            |
| TV             | `tv`            | A media player on a TV                       | Media   | Office TV                  | Media            |
| Speaker        | `speaker`       | A speaker that only plays, shown as one      | Media   | Office Speaker             | Media            |
| Sensor         | `sensor`        | A sensor that measures                       | Sensor  | Office Temperature Sensor  | Environment      |
| Unknown device | `unknown`       | A device with no part Sanctum can use        | Nothing | Unknown Device             | Unknown devices  |

**Needs** is the part a device must have to be of that type. A driver can
declare a device with a light part as a light even if it also has a button
or a temperature sensor.

## How a device gets its type

The driver that brings the device in says what it is. When the driver
knows no more than the device's parts, the type is the first of these that
the device has a part for: light, switch, button, motion sensor, contact
sensor, media player, sensor. A device with no parts is unknown. That order is why:

- a light that also has a button or a sensor is a **light**;
- a relay that also has a button is a **switch**;
- a motion sensor that also measures is a **motion sensor**;
- a contact sensor that also measures is a **contact sensor**.

Only the driver can identify a plug or a smart speaker. The household
chooses whether to show a device as a door, window, TV or speaker.

## Plug or switch

A plug and a switch have the same part: they turn on and off. Only the
driver can tell them apart, from what the device says of itself, such as a
model called "Smart plug". When it can't tell, the device is a switch.

## Door and window

A contact sensor can be shown as a door or window. In **Settings → Devices**,
open the device's menu and choose **Show as**. The options are **Contact
sensor**, **Door** and **Window**. A door in the Office is automatically
named "Office Door" and shows as open or closed like any contact sensor.

Only the household chooses Door or Window; a driver never says them. The
choice can be changed back at any time, and the device stays a contact
sensor underneath.

## TV and speaker

A media player can be shown as a TV or a speaker, as a contact sensor can
be shown as a door: in **Settings → Devices**, open the device's menu and
choose **Show as**. A TV box in the Living Room shown as a TV is the
"Living Room TV"; a speaker shown as a speaker is the "Living Room
Speaker".

Only the driver can identify a voice-enabled speaker as a smart speaker.
Its name ends in "Speaker" too, as in "Office Speaker".

## Sensors are named by what they measure

A sensor's automatic name says what it measures.

| It measures            | It is called       |
| ---------------------- | ------------------ |
| Temperature            | Temperature sensor |
| Humidity               | Humidity sensor    |
| Light level            | Light sensor       |
| More than one of these | Environment sensor |

So a sensor in the Office that measures temperature and humidity is the
"Office Environment Sensor".

A motion sensor or contact sensor that also measures still takes its name
from its type. For example, a motion sensor that measures the light level
is still "Office Motion Sensor".

## Unknown devices

A device with none of the parts Sanctum knows is an unknown device. It
still belongs to the household: it can be named, put in a room and removed.
Its automatic name starts from "Unknown Device" in any room and uses the
same numbering as other devices. On a room's page it sits under **Unknown
devices**, after the category sections, with the name its driver gives it
underneath.

## Names

Sanctum names a device after its room and its type, with each word starting
with a capital: "Office Light". A device in no room goes by its type alone:
"Light". When another device already has the name, Sanctum adds a number
from 2: "Office Light 2".

The name follows the device. Moved to the Kitchen, the Office Light becomes
the "Kitchen Light", and shown as a door, the Office Contact Sensor becomes
the "Office Door". A device keeps its number while it is free, so removing
the Office Light doesn't rename the Office Light 2.

A name the household gives a device stays as it is: Sanctum no longer
renames it. Clearing that name hands the device back to Sanctum's naming.
