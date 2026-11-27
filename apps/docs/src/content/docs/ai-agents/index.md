---
title: Use Sanctum from an AI agent
description: What an AI agent can do with your home, what it needs, and how to add and remove one.
sidebar:
  order: 1
---

:::caution
Sanctum's connector, `@meetsanctum/mcp`, isn't on npm yet, so the command
in the prompt fails for now. This page describes how adding an agent works
once it's published.
:::

An AI agent is an AI program that runs on a computer, such as Claude Code or
Codex. Once you add one, you can ask it in your own words to dim the living
room, turn the office lights up so you can see, or run the Evening mood.
Sanctum tells the agent to ask which room when it's unclear and to report
what it changed.

Agents are optional, and you choose what they can use. Until you add one,
nothing in Sanctum is open to them.

## What it needs

- **An agent that runs commands,** such as Claude Code or Codex, on a computer
  in your home. It has to be on the same network as Sanctum. Agents that run
  in the cloud, such as claude.ai, ChatGPT or Codex on the web, can't reach
  your home.
- **Node.js 22 or newer** on that computer. The agent runs Sanctum's small
  connector, `@meetsanctum/mcp`, with `npx`.

## Adding an agent

1. Open **Settings → AI Agents** and choose **Add an agent**.
2. Give it a name you'll recognise, such as "Codex on the office Mac". The
   sheet lists everything AI agents can use, under **On** and **Off until you
   switch them on**. You can change any of it later, as
   [What AI agents can use](/ai-agents/what-they-can-use/) explains.
3. Choose **Continue**. Sanctum shows a prompt to paste into the agent, such
   as:

   > Connect to my Sanctum home. Run `npx -y @meetsanctum/mcp@0.1.0 connect
sanctum:…` and do what it says.

   The prompt contains a one-time setup code that expires after 10 minutes.
   Share it only with the agent you want to add.

4. Choose **Copy prompt**, and paste it into the agent on that computer. The
   agent runs the command and tells you what happened.
5. The sheet says the agent is connected once it has reached your home, with
   the address it connected from. Choose **Done**.

If the connector prints a registration command, run it for your agent.
Once the connector is registered, start a new session with the agent to
use Sanctum's tools. If the prompt runs out before the connector reaches
your home, the sheet says so, and **Make a new prompt** gives you another.

### What the connector does

The prompt runs the connector on the agent's computer. It handles the
home's certificate and the agent's key for you.

- **It checks it's your home** before it sends the setup secret. The code in
  the prompt carries your home's identity, and the connector refuses any
  computer on the network that can't prove it's that home.
- **It keeps the agent's key safe:** in the Keychain on a Mac, the Credential
  Manager on Windows, or the Secret Service on Linux. Where there's none, as
  over SSH, it keeps the key in a file only you can read, and says so. The key
  is never in the agent's settings, its chat or your shell's history.
- **It adds itself to Claude Code or Codex** as an MCP server named after
  your home, such as `sanctum-home`. Adding the same agent again on that
  computer replaces it there, though the earlier one can still be listed in
  Sanctum until you remove it.

### Setting it up by hand

For an agent that can't run commands itself, choose **Set it up by hand** on
the sheet. Choose **Copy command** and run it in a terminal on that computer.
The connector sets up its connection to your home and prints the commands
for Claude Code and Codex. Run the command for your agent, then start a new
session. The registration commands contain no secret.

### When the agent asks before acting

Claude Code and Codex can ask you before they use one of Sanctum's tools, as
they do for their other tools. Answer as you would there.

`codex exec` runs without anyone at the keyboard and can refuse calls that
require approval, such as turning on a light. To let Codex use the server's
tools without asking, find the existing `[mcp_servers.sanctum-home]` section
in `~/.codex/config.toml`, using the name the connector gave it. Add this
line to that section.

```toml
default_tools_approval_mode = "approve"
```

## Your agents

**Settings → AI Agents** lists each agent with who added it, when, and when
it last reached Sanctum, such as "Added by Maya on 20 Nov · Seen 5 minutes
ago".
Anyone in the household sees and manages every agent, from any device.

What an agent does shows in **Settings → Activity** under its name, so you
can see which agent turned which light on.

If you add the same agent twice, as when a first try didn't finish, both
can be listed under one name. Their lines then give the time each was added,
so you can tell which one to keep.

### Renaming and removing

Choose **⋮** beside an agent:

- **Rename** changes the name shown here and on new activity entries.
- **Remove** stops it at once. A command it already sent, such as a light
  turning on, may still finish. To use the agent again, add it again.

The next time the connector reaches Sanctum, it learns that the agent was
removed and clears its stored key. To remove the MCP server from Claude Code
or Codex too, run the corresponding command below on the agent's computer.
Replace `sanctum-home` with the name the connector gave the server.

```sh
claude mcp remove sanctum-home -s user
```

```sh
codex mcp remove sanctum-home
```

## What an agent can do

What an agent can use is set for every agent at once, on
[What AI agents can use](/ai-agents/what-they-can-use/). With the defaults,
an agent can:

- **See your home:** its floors, rooms, zones and the devices it may see,
  with what they're doing now.
- **Change your lights:** turn them on or off, make them brighter or dimmer,
  or set their brightness, a white or a colour. It can do this for a room,
  a floor, a zone, the whole home or chosen lights, as the room's Lights
  tile does. Turning lights on goes by the room's own rule. Setting just
  the brightness changes the lights that are on. If all are off, the
  room's rule chooses which lights come on at that brightness. A white
  brings every light to it, including those that are off, and a colour
  every light that can show one.
- **Use your apps:** run a mood, or have lights follow natural light, for
  example.
- **Put its own change back:** a light it changed goes back to how it was,
  as long as it still looks as the agent left it. Sanctum keeps the last five such
  changes per agent for up to an hour. Restarting Sanctum clears that list.
  Running a mood doesn't create a change that the agent can put back.

With **Control your switches** on, an agent can also turn switches and
plugs on or off and put those commands back under the same rules.

Some things are never open to agents, whatever you switch on: adding,
removing or renaming devices, rooms, floors and people; adding, updating or
removing apps; and sign-ins, updates and backups.

Sanctum limits how many commands agents can send a minute, so an agent that
goes wrong can't flood your devices.
