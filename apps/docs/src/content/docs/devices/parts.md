---
title: What each part does
description: The seven parts a device can have, what each one says and what it can be asked to do.
sidebar:
  order: 4
---

Each part of a device does one thing, and works the same whichever app
brings the device in: a Zigbee light and an ESPHome light are asked the
same things and say the same things.

Every part says what it can do when its device joins, such as whether a
light dims. Sanctum offers only what the part can do, so a light that can't
change colour has no colours to choose.

| Part        | Id        | It says                                                | It can be asked to                 |
| ----------- | --------- | ------------------------------------------------------ | ---------------------------------- |
| Light       | `light`   | On or off, brightness, colour                          | Turn on or off, dim, change colour |
| Switch      | `switch`  | On or off                                              | Turn on or off                     |
| Sensor      | `sensor`  | One reading                                            | Nothing                            |
| Motion      | `motion`  | Motion or none                                         | Change its settings                |
| Contact     | `contact` | Open or closed                                         | Nothing                            |
| Media       | `media`   | What it plays, and how loud                            | Play, pause, skip, set its volume  |
| Microphones | `audio`   | Whether they're muted, and when it heard its wake word | Mute or unmute them; announce      |
| Button      | `button`  | That it was pressed, and how                           | Nothing                            |

## Light

A light turns on and off. Depending on the light, it can also:

- **dim**, from 1% to 100%;
- **change its white**, from warm to cool, within the range the light has;
- **show a colour**.

A light can fade to a new state over a few seconds instead of jumping,
where its driver supports it.

Sanctum waits for the light to confirm each change. If the light never
does, its tile says "Not responding". A light that is off can be given the
brightness or colour it comes back on at: its tile then says, for example,
"Off · 40% when on".

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

A motion part says whether it sees movement now. When it doesn't, its
tile says "Quiet", or for how long: "Quiet for 5 min". Quiet means nothing
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

## Media

A media part plays sound or video. The core accepts commands for the
features the part declares when it joins.

- **Power:** whether it turns on and off.
- **Playback:** which of play, pause, stop, next, previous and seek it
  takes.
- **Volume:** a level it can be set to, only up and down, or neither. A TV
  box that sends its sound to the TV over HDMI can only pass up and down on
  to the TV, which never says how loud it is.
- **Mute:** whether it can be muted.

It says whether it is playing, paused, loading or idle, and whatever it
knows of what is playing: its title, artist, album, series, season and
episode, how long it is and where it is, the app playing it, and a picture
of it, which its driver hands over and the Playing page shows, its colour
on the glass behind. Where it
has them, it also says whether it is on, its volume and whether it is muted.

Turning it on or off, playing or pausing, a volume and mute wait for the
player to say it did them, as a light's on does. A step of the volume,
stop, next, previous and a place in what is playing ask for nothing the
player can confirm, so each is done once its driver takes it.

History keeps when a media player played and when it was on, never what it
played or how loud.

## Microphones

A microphones part belongs to a device that listens for its wake word, such
as a smart speaker: it makes the device a smart speaker. It says whether its
microphones are muted, where they can be, and when it last heard its wake
word. It never carries what the microphones hear.

- **Mutes:** whether Sanctum can mute and unmute them.
- **Mute switch:** whether the device has a mute switch of its own, as the
  Home Assistant Voice PE has on its side. That switch mutes them too, and
  while it's on, only it turns them back on: an unmute is refused within
  2 seconds, and the button shakes red and stays muted.
- **Announces:** whether the device plays an announcement: something
  Sanctum says out loud, in its own voice, over whatever the device is
  playing, which goes quieter meanwhile. Only Sanctum sends one, when an AI
  agent asks it to speak (see [What AI agents can
  use](/ai-agents/what-they-can-use/)); no app or person sends one as a
  command.
- **Listens:** whether its wake word or button starts a request whose sound
  its driver can hand Sanctum. Sanctum declines each request before any of
  its sound leaves the device.

Muting and unmuting wait for the device to say it did them. History keeps
nothing of its microphones. Where Sanctum can mute its microphones, a smart
speaker has a button for them beside its mute on Volume, or beside its power
on Remote.

## Button

A button part has no state: a press is a moment, not a setting. It says
which presses it makes, by the names its driver uses, such as single,
double or hold, and on a remote with several buttons, which button:
"up_hold" is the up button held.

A hold lasts until the button is let go, so holding a remote's button can
brighten or dim lights until it is released.

## What isn't a part

A battery report describes the whole device. It has no effect on the
device's type or category. You can find reported battery information in
**Settings → Devices** and on the device's **Motion**, **Contact**,
**Door**, **Window** or **Readings** tab when it has one.
