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

A light can fade to a new state if it supports transitions. When a remote
is set up to dim a light by holding a button, the light's driver must
support that kind of dimming.

The tile can show a requested change while Sanctum waits for the light to
confirm it. If the light fails to confirm it, the tile says "Not responding".
A command can also leave a light off and set the brightness or colour it
will use when it turns on. Its tile then says, for example, "Off · 40% when on".

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

A motion part says whether its sensor detects motion. When it reports no
motion, the tile says "Quiet" or how long it has been quiet. A motion
sensor can report "Quiet" while someone is sitting still.

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

Letting go of a held button ends the hold and stops any dimming it started.
Dimming can also end sooner, for example if another command changes the
light.

## What isn't a part

A battery report describes the whole device. It has no effect on the
device's type or category. You can find reported battery information in
**Settings → Devices** and on the device's **Motion**, **Contact**,
**Door**, **Window** or **Readings** tab when it has one.
