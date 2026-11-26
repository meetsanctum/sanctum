---
title: What AI agents can use
description: The switches that decide what AI agents can see and do in your home and in each app.
sidebar:
  order: 2
---

One list decides what AI agents can use, for every agent at once. The
household sets it: the home's own parts in Settings, and each app's part on
that app's settings page. Sanctum starts with sensible defaults, and you can
change any of them at any time, from any device.

Agents are told what's switched off, so they can tell you why they can't do
something, and where it's decided.

## Your home

**Settings → AI Agents → What AI Agents Can Use** lists each part of your
home in the same words as apps' [permissions](/apps/permissions/).

| What AI agents can use                                        | Starts                   |
| ------------------------------------------------------------- | ------------------------ |
| See your rooms                                                | Always on                |
| Control your lights                                           | On                       |
| See your switches                                             | On                       |
| Control your switches                                         | Off                      |
| Speak on your smart speakers                                  | On                       |
| See what your sensors read                                    | Off                      |
| See your remotes' presses                                     | Off, and asks to turn on |
| Know when there's motion                                      | Off, and asks to turn on |
| Know whether your doors, windows and contact sensors are open | Off, and asks to turn on |
| See what happened at home                                     | Off, and asks to turn on |
| See what your devices reported                                | Off, and asks to turn on |
| See who lives here                                            | Off, and asks to turn on |

- **See your rooms** is always on: without your rooms, an agent can do
  nothing by room.
- **Control your lights** includes seeing them. **See your switches**
  includes plugs, and **Control your switches** also lets an agent see
  and turn switches and plugs on or off.
- **Speak on your smart speakers** lets an agent have Sanctum say something
  out loud on one smart speaker that can announce, such as "Dinner's ready":
  up to 300 characters, in English or German, always in Sanctum's own voice.
  A speaker says one thing at a time: what's sent while it speaks waits its
  turn, up to two waiting, and plays as soon as the one before ends. A speaker
  says at most four a minute, and an agent six a minute. A speaker says
  nothing while offline, muted or turned all the way down, also when it gets
  that way while an announcement waits, and the agent is told why. The activity log keeps what was said
  and which agent asked.
- **What Tells Who's Home:** motion, doors and windows, remotes' presses,
  the activity log, what your devices reported, and the names of the people
  who live here can show when someone is home. Each asks before it turns on,
  since an agent may share what it reads with the company that runs it.
- **See what happened at home** covers activity for devices the agent can
  see. It includes people's names only when **See who lives here** is on
  too. **See what your devices reported** goes back up to 10 days for devices
  the agent can see and whose history your home keeps.

Turning something off works at once: an agent's next request that needs it
is refused. Turning off **Speak on your smart speakers** also drops what's
still waiting to be said; what a speaker is already saying finishes.

## In your apps

Below your home's switches, **In Your Apps** lists each app that offers
something to AI agents, with how many of its items are on, such as "2 of 3
on". Choose an app to open its settings page.

Once your home has an agent, each of those apps' settings pages has a
**What AI Agents Can Use** section under its permissions:

- **Actions** are what an agent can do in the app, such as run a mood.
- **Information** is what an agent can read from it, such as the forecast.

An item that needs something switched off says so, such as "Needs Control
your lights, which is off for AI agents". Where that's one of your home's
switches, **Change it in Settings** takes you there.

These are the defaults when you add each app for the first time.

| App           | Item                           | Starts |
| ------------- | ------------------------------ | ------ |
| Moods         | Run a mood                     | On     |
| Moods         | Mood                           | On     |
| Moods         | Create a mood                  | Off    |
| Natural light | Follow natural light           | On     |
| Natural light | Follow natural light in a room | On     |
| Natural light | Bring a room to natural light  | On     |
| Natural light | Pause natural light            | On     |
| Natural light | Resume natural light           | On     |
| Natural light | Light following the sun        | On     |
| Natural light | Today's natural light          | Off    |
| Weather       | Forecast                       | On     |
| Weather       | Sun                            | Off    |

Today's natural light and the sun start off because sunrise and sunset tell
roughly where your home is.

An app never offers what it keeps for people. Moods doesn't let agents
delete a mood, for example, and no app lets an agent add devices.

### Items from an update

New items from an app update start off. This also applies when an app you
already use first adds items for agents. If an update changes an item from
reading information to taking an action, its switch goes back off.
