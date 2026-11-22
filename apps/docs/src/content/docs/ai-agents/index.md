---
title: Use Sanctum from an AI agent
description: What an AI agent can do with your home, what it needs, and how to add and remove one.
sidebar:
  order: 1
---

An AI agent is an AI program that runs on a computer, such as Claude Code or
Codex. Once you add one, you can ask it in your own words to dim the living
room, turn the office lights up so you can see, or run the Evening mood. It
asks which room when you don't say, and tells you what it changed.

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

1. Open **Settings → AI agents** and choose **Add an agent**.
2. Give it a name you'll recognise, such as "Codex on the office Mac". The
   sheet lists everything AI agents can use, under **On** and **Off until you
   switch them on**. You can change any of it later, as
   [What AI agents can use](/ai-agents/what-they-can-use/) explains.
3. Choose **Continue**. Sanctum shows a prompt to paste into the agent, such
   as:

   > Connect to my Sanctum home. Run `npx -y @meetsanctum/mcp@0.1.0 connect
sanctum:…` and do what it says.

   The prompt works once, and expires 10 minutes after you make it.

4. Choose **Copy prompt**, and paste it into the agent on that computer. The
   agent runs the command and tells you what happened.
5. The sheet says the agent is connected once it has reached your home, with
   the address it connected from. Choose **Done**.

Start a new session with the agent afterwards: Sanctum's tools are there
from its next session. If the prompt runs out first, the sheet says so, and
**Make a new prompt** gives you another.

### What the connector does

The prompt runs the connector on the agent's computer. It's the only way an
agent reaches your home, and it keeps you from handling certificates or
passwords:

- **It checks it's your home** before it sends anything. The code in the
  prompt carries your home's identity, and the connector refuses any computer
  on the network that can't prove it's that home.
- **It keeps the agent's key safe:** in the Keychain on a Mac, the Credential
  Manager on Windows, or the Secret Service on Linux. Where there's none, as
  over SSH, it keeps the key in a file only you can read, and says so. The key
  is never in the agent's settings, its chat or your shell's history.
- **It adds itself to the agent** as an MCP server named after your home, such
  as `sanctum-home`. Adding the same agent again replaces it.

### Setting it up by hand

For an agent that can't run commands itself, choose **Set it up by hand** on
the sheet. It shows the same command to run yourself in a terminal on that
computer. The connector sets itself up, then shows the lines that add it to
your agent. Nothing secret is in them.

### When the agent asks before acting

Claude Code and Codex can ask you before they use one of Sanctum's tools, as
they do for their other tools. Answer as you would there.

`codex exec`, which runs Codex without anyone at the keyboard, can't ask. It
refuses any call that changes something, such as turning a light on, unless
you allow Sanctum's tools in Codex's `config.toml`:

```toml
[mcp_servers.sanctum-home]
default_tools_approval_mode = "approve"
```

Use the name the connector gave the server.

## Your agents

**Settings → AI agents** lists each agent with who added it, when, and when
it was last seen, such as "Added by Maya on 20 Nov · Seen 5 minutes ago".
Anyone in the household sees and manages every agent, from any device.

What an agent does shows in **Settings → Activity** under its name, so you
can see which agent turned which light on.

If you add the same agent twice, as when a first try didn't finish, both
can be listed under one name. Their lines then give the time each was added,
so you can tell which one to keep.

### Renaming and removing

Choose **⋮** beside an agent:

- **Rename** changes the name it goes by here and in the activity log.
- **Remove** stops it at once. A command it already sent, such as a light
  turning on, may still finish. To use the agent again, add it again.

Removing an agent in Sanctum doesn't take the MCP server out of the agent.
The next time the agent tries to use it, it hears that it was removed, and
the connector forgets its key. To take the server out of the agent too:

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

- **See your home:** its floors, rooms and the devices it may see, with what
  they're doing now.
- **Change your lights:** on or off, brighter or dimmer, or a brightness and
  colour temperature, for a room, a floor, the whole home or chosen lights.
  Turning lights on goes by the room's own rule, as its lights button does.
- **Use your apps:** run a mood, or have lights follow natural light, for
  example.
- **Put its own change back:** each light it changed that still looks as it
  left it goes back to how it was. A light someone changed since is left as
  it is. An agent can put back any of its last 5 changes, for an hour.

Some things are never open to agents, whatever you switch on: adding,
removing or renaming devices, rooms, floors and people; adding, updating or
removing apps; and sign-ins, updates and backups.

Sanctum limits how many commands agents can send a minute, so an agent that
goes wrong can't flood your devices.
