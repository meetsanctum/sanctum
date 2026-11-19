---
title: What each part does
description: The six parts a device can have, what each one says and what it can be asked to do.
sidebar:
  order: 4
---

Each part of a device does one thing, and works the same whichever app
brings the device in: a Zigbee light and an ESPHome light are asked the
same things and say the same things.

Every part says what it can do when its device joins, such as whether a
light dims. Sanctum offers only what the part can do, so a light that can't
change colour has no colours to choose.

| Part    | Id        | It says                       | It can be asked to                 |
| ------- | --------- | ----------------------------- | ---------------------------------- |
| Light   | `light`   | On or off, brightness, colour | Turn on or off, dim, change colour |
| Switch  | `switch`  | On or off                     | Turn on or off                     |
| Sensor  | `sensor`  | One reading                   | Nothing                            |
| Motion  | `motion`  | Motion or none                | Change its settings                |
| Contact | `contact` | Open or closed                | Nothing                            |
| Button  | `button`  | That it was pressed, and how  | Nothing                            |

## Light

A light turns on and off. Depending on the light, it can also:

- **dim**, from 1% to 100%;
- **change its white**, from warm to cool, within the range the light has;
- **show a colour**.

A light can fade to a new state over a few seconds instead of jumping, and
its brightness can rise or fall for as long as a remote's button is held.

A change waits for the light to confirm it, and if the light never does,
its tile says "Not responding". A light that is off can be given the brightness or colour it
comes back on at: its tile then says, for example, "Off · 40% when on".

## Switch

A switch turns something on and off: a relay, a plug, a wall switch. It
has nothing else.

## Sensor

A sensor part measures one thing:

| It measures | In              |
| ----------- | --------------- |
| Temperature | Degrees Celsius |
| Humidity    | Percent         |
| Light level | Lux             |

A device that measures two things has two sensor parts. Sanctum keeps every
reading in these units, whatever the device sends, so a rule such as "below
18 °C" means the same in every home. The app shows temperatures in the unit
the household chooses.

## Motion

A motion part says whether it sees movement now. "No motion" means nothing
moved for a while, not that nobody is there: someone sitting still at a
desk makes no motion.

Some motion sensors have settings, each only where the sensor has it:

- **sensitivity**, how readily it sees movement, in the levels it has;
- **how long it waits** after the last movement before it says no motion;
- **whether its light blinks** when it sees movement.

## Contact

A contact part says whether what it sits on is open or closed, and Sanctum
remembers since when: "Open for 12 min". It is asked nothing. The household
can [show it as a door or a window](/devices/types/#door-and-window).

## Button

A button part has no state: a press is a moment, not a setting. It says
which presses it makes, by the names its driver uses, such as single,
double or hold, and on a remote with several buttons, which button:
"up_hold" is the up button held.

A hold lasts until the button is let go, so holding a remote's button can
brighten or dim lights for as long as it is held.

## What isn't a part

A device's battery and how well it reaches the network belong to the
device itself, not to a part, so they don't decide its type or put it in a
category. Its battery shows when the device is opened.
