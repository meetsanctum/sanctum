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

A driver registers each device with `ctx.devices.register`, and registers
it again whenever something about it changes. It says:

- **a key**, the driver's own id for the device, which stays the same for
  as long as the device exists;
- **a name**, the device's own or its model's, which Sanctum uses until it
  [names the device after its room](/devices/types/#names);
- **its maker and model**, where known;
- **its type**, one of the [device types](/devices/types/);
- **its parts**, each with an id, its [kind](/devices/parts/), and what it
  can do, such as whether a light dims.

Registering again with the same key updates the device. The household's
name for it, its room and what it is shown as stay as they are.

## Picking the type

The driver picks the type, since it knows what the device says of itself.
Most protocols tell no more than the device's parts, and for those the SDK
gives the type from them: `deviceTypeOf` takes the parts' kinds and returns
the first type in the [list of types](/devices/types/#every-type) that fits.
That is how a light with a button comes out as a light.

Two types need more than the parts:

- **Plug.** A plug's part is a switch, so `deviceTypeOf` never gives it. A
  driver says plug when the device tells it so: Zigbee does when the
  device's name or model has the word plug, outlet or socket in it, and
  ESPHome when its switches are marked as outlets.
- **Door and window.** A driver never says them. Only the household
  [chooses them](/devices/types/#door-and-window), for a contact sensor.

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
- **Ids that read well after the device's name.** A device with two parts
  of the same kind shows a tile for each, named with the part's id: "Relay
  1" and "Relay 2", or "Hallway Switch left".
- **Standard units.** Readings arrive in degrees Celsius, percent and lux,
  whatever the device sends.
- **Presses as they happen.** A button's presses go to `ctx.devices.press`,
  one call for each press, never as state. A hold ends with
  `ctx.devices.release` when the button is let go.

## In the code

The types, categories and parts are defined in `@meetsanctum/app-sdk`
(`packages/app-sdk/src`), which every driver builds on:

| File                     | Holds                                                   |
| ------------------------ | ------------------------------------------------------- |
| `device-types.ts`        | The types, what each needs, their names, `deviceTypeOf` |
| `device-categories.ts`   | The categories and the kind of part each holds          |
| `devices.ts`             | The parts: what each can do, says and is asked          |
| `device-registration.ts` | What a driver registers, and the check of its type      |

The Zigbee and ESPHome drivers, in `catalog/apps/zigbee` and
`catalog/apps/esphome`, show both ways of picking a type: by the parts, and
by what the device says of itself for a plug.
