# @meetsanctum/mcp

Connects an AI agent on a computer at home, such as Claude Code or Codex, to
[Sanctum](https://meetsanctum.com) over MCP.

Someone adds the agent in Sanctum's Settings, under AI agents, and pastes
the prompt it gives into the agent. The prompt has the agent run:

```sh
npx -y @meetsanctum/mcp@<version> connect sanctum:…
```

The connector then:

- finds the home on the network by its id, and checks the home's
  certificate against the pin in the code before it sends anything;
- trades the code's one-time secret for the agent's token, and keeps the
  token in the system's secure storage (the Keychain, the Credential
  Manager or the Secret Service), or in a file only this user can read where
  there's none;
- registers itself with the agent as an MCP server named after the home,
  such as `sanctum-office`, with `claude mcp add` or `codex mcp add`.

The agent starts it with `serve --connection <id>`: an MCP server on stdio,
for agents on the 2025-11-25 or the 2026-07-28 revision, which passes the
agent's calls on to the home. What the agent can do is decided in Sanctum's
Settings, under What AI agents can use.

If a tool call loses its reply, check the home's state before trying again.
The connector reconnects for the next call.

Needs Node 22 or later. Its files are in `~/.config/sanctum-mcp`, or
`%APPDATA%\Sanctum MCP` on Windows, or `SANCTUM_MCP_DIR`.

`--local` registers the connector the command ran from instead of the
published package, for one built from source.
