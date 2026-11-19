---
title: Device types
description: Every type of device Sanctum knows, what each needs, what it is called and where it shows.
sidebar:
  order: 2
---

A device's type is what the whole device is. Sanctum knows the types below
and no others. A device that fits none of them is an unknown device.

## Every type

| Type           | Id        | What it is                                   | Needs   | In the Office it is called | On a room's page |
| -------------- | --------- | -------------------------------------------- | ------- | -------------------------- | ---------------- |
| Light          | `light`   | A bulb, a strip, a lamp                      | Light   | Office Light               | Lights           |
| Plug           | `plug`    | A plug that switches what is plugged into it | Switch  | Office Plug                | Switches         |
| Switch         | `switch`  | A relay or wall switch                       | Switch  | Office Switch              | Switches         |
| Button         | `button`  | A remote or wall button                      | Button  | Office Button              | Buttons          |
| Motion sensor  | `motion`  | A sensor that sees movement                  | Motion  | Office Motion Sensor       | Presence         |
| Contact sensor | `contact` | A sensor that says whether something is open | Contact | Office Contact Sensor      | Security         |
| Door           | `door`    | A contact sensor on a door                   | Contact | Office Door                | Security         |
| Window         | `window`  | A contact sensor on a window                 | Contact | Office Window              | Security         |
| Sensor         | `sensor`  | A sensor that measures                       | Sensor  | Office Temperature Sensor  | Environment      |
| Unknown device | `unknown` | A device with no part Sanctum can use        | Nothing | Unknown Device             | Unknown devices  |

**Needs** is the part a device must have to be of that type. It may have
other parts too: a light with a button and a temperature sensor is still a
light.

## How a device gets its type

The driver that brings the device in says what it is. Where the driver can
tell no more than the device's parts, the type comes from the first row
above whose part the device has. That order is why:

- a light that also has a button or a sensor is a **light**;
- a remote that also switches a relay is a **button**;
- a motion sensor that also measures is a **motion sensor**;
- a contact sensor that also measures is a **contact sensor**.

## Plug or switch

A plug and a switch have the same part: they turn on and off. Only the
driver can tell them apart, from what the device says of itself, such as a
model called "Smart plug". When it can't tell, the device is a switch.

## Door and window

A contact sensor can't tell whether it is on a door or a window, so the
household says so: in the device's menu, **Show as** offers Contact sensor,
Door and Window. A door is named "Office Door" and shows as open or closed
like any contact sensor.

Only the household chooses Door or Window; a driver never says them. The
choice can be changed back at any time, and the device stays a contact
sensor underneath.

## Sensors are named by what they measure

A sensor's name says what it measures:

| It measures            | It is called       |
| ---------------------- | ------------------ |
| Temperature            | Temperature sensor |
| Humidity               | Humidity sensor    |
| Light level            | Light sensor       |
| More than one of these | Environment sensor |

So a sensor in the Office that measures temperature and humidity is the
"Office Environment Sensor".

A motion sensor or contact sensor that also measures keeps its own name:
it is still the "Office Motion Sensor".

## Unknown devices

A device with none of the parts Sanctum knows is an unknown device. It
still belongs to the household: it can be named, put in a room and removed.
It is called "Unknown Device" in any room, since a room's name in front of
it would promise more than is known about it. On a room's page it sits
under Unknown devices, after every category, with the name its driver gives
it underneath.

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
