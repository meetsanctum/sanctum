# Contributing to Sanctum

Thanks for your interest in Sanctum. Bug reports and ideas are welcome in
[Issues](https://github.com/meetsanctum/sanctum/issues). Sanctum doesn't take
outside pull requests at the moment.

This guide is for running Sanctum from source and finding your way around the
code. [AGENTS.md](AGENTS.md) holds the rules the code follows, for people and
coding agents alike.

## What you need

- Node.js 24 or newer and pnpm 10 (`corepack enable` picks the version in
  `package.json`).
- Docker, for the development stack and the container tests.
- For a host of your own: a Raspberry Pi 4 or another 64-bit Linux machine
  with Docker, and a Zigbee USB stick that Zigbee2MQTT supports.

## Getting started

```sh
pnpm install
pnpm dev          # the manager and core in Docker, client on :5173, website on :5174, docs on :5175
pnpm dev:seed     # a claimed home: sixty fake devices in nine rooms, its sensors changing
pnpm dev:status   # the core's address, and any other stacks
pnpm dev:stop     # stop this worktree's stack
pnpm dev:down     # remove this worktree's stack and its data
```

`pnpm dev` runs a stack for each checkout or worktree, on a port of its own.
Its apps run in containers of their own, as on a host, the fake lights too:
the manager stages each from the worktree's build, and a new build is an
update, so a saved change to an app runs about ten seconds later, with the
app's data copied first.
The client's dev server proxies `/api` to the core. To call the core
cross-origin instead, as the desktop app does, point the client at the core
and allow the client's origin:

```sh
VITE_SANCTUM_CORE_URL=http://127.0.0.1:<port> \
CORE_ALLOWED_ORIGINS=http://localhost:5173 pnpm dev
```

Apps' pages and device pages open in frames the core serves; the client
bundles none of them. The core lets only the origins it allows show its
pages in a frame, so for the dev server's shell start the stack with
`CORE_ALLOWED_ORIGINS=http://localhost:5173`. A saved change to an app's
pages shows in its frame once the stack has staged the new build, about ten
seconds later: the frame opens afresh on the app's new build. A change that
doesn't build leaves the last good pages, and a rebuilt kit is read again.

`pnpm dev` runs the core over plain HTTP, for development only. On a host the
core serves only HTTPS, with a certificate the manager signs as the host's
certificate authority, and the desktop app pins that authority. The desktop
app finds hosts on the network and talks to them cross-origin; see
[apps/desktop](apps/desktop/README.md).

### A wall display

```sh
pnpm dev:display              # pnpm dev, with the client on the network on :8123
pnpm dev:approve ABCD-EFGH    # approve the code the display shows
```

`pnpm dev:display` runs the plain-HTTP development stack and opens the
client's dev server on the Mac's network interfaces. A wall display such as
Shelly's accepts an address in its Home Assistant slot only when it answers
Home Assistant's first sign-in step. The dev server answers that step and
serves the Sanctum client. The core allows the network addresses as origins
so apps' pages can open in frames. Give the display a Network address from
Vite's output, choose the home, then "This is a shared device". Approve its
code with `pnpm dev:approve <code> [name]` after setting up the home with
`pnpm dev:seed`. Anyone on the network can reach the stack over this port
and use the seed's login.

`SANCTUM_DISPLAY_PORT` sets the display port. Give each concurrent
worktree's display mode its own port. Set `SANCTUM_DISPLAY_TOUCHES=true` to
record each gesture's pointer and touch events in the worktree's
`.sanctum-display-touches.jsonl` file.

Set `SANCTUM_DISPLAY_FRAMES=true` to record frame gaps, input that took a
frame or more to show, long animation frames with their longest scripts, and
how often a moving finger reports. The recorder samples the first words of
the screen so you can check which screen the run timed. The timings go to
`.sanctum-display-frames.jsonl` on this Mac. Use the local command line to
change what the display shows and measures:

```sh
pnpm --filter @meetsanctum/client build:display   # the production client, served at /__display/built/
curl -d '{"page":"built","label":"home scroll"}' localhost:8123/__display/control
curl -d '{"blur":false}' localhost:8123/__display/control   # or masks; reload: true loads the page again
node apps/client/dev/display-frames-summary.ts     # one block per page, label and effects, with its screens
```

Choose `dev` for the dev client, `built` for the built client, or `blank` for
a page with just the frame recorder. Build the client before switching to
`built`. The built client uses the same address, so the display keeps its
sign-in.

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm format:check
pnpm test:containers   # real stacks and images in Docker, which takes minutes
```

Use focused runs while iterating, such as `pnpm --filter @meetsanctum/core
test`, then the full set before you finish. After changing an app's actions,
events, settings or widgets, run `pnpm manifest` and commit the regenerated
`sanctum-app.json`.

## How it fits together

```
clients (the shell in the desktop app or a browser)
   │  HTTPS and a WebSocket, only ever to the core
   ▼
core ── hosts the apps, keeps the household's data, checks every request
   │  a local socket
   ▼
manager ── Docker, updates and rollback, backups, certificates, USB and serial
```

- **The core** (`apps/core`) owns what the whole home shares: people,
  places, devices, dashboards, workflows, history and the activity log. It
  hosts the apps and is the only thing clients talk to.
- **Apps** (`catalog/apps/*`) are built with `@meetsanctum/app-sdk`: each
  declares its actions, events, settings and what it provides in a manifest,
  and keeps its data in a SQLite file of its own. Driver apps, such as
  Zigbee, connect devices to the core.
- **The manager** (`apps/manager`) is the only privileged process. It starts
  and updates the core and the services apps ask for (Mosquitto,
  Zigbee2MQTT, Ollama), backs up before each update and rolls back when a new
  version isn't healthy.
- **The shell** (`apps/client`) is the React app behind every screen. Apps'
  pages are built with `@meetsanctum/ui-sdk`, served by the core and shown
  in sandboxed frames, which talk to the shell over a message channel.

## Repository layout

```
apps/core                  the core: modules, app host, client gateway
apps/manager               the privileged process: Docker, updates, backups
apps/client                the React + Vite shell
apps/desktop               the Electron desktop app
apps/website               the landing page and its waitlist
apps/docs                  the documentation site, built by Starlight
packages/app-sdk           defineApp, defineAction, defineEvent, schemas
packages/ui-sdk            what apps' pages import: components, the app client
packages/auth-protocol     Auth's routes, sign-in binding and rules
packages/mcp               @meetsanctum/mcp, the connector AI agents reach a home through
packages/typescript-config shared TypeScript settings
catalog/apps/*             Sanctum's apps, driver apps included
assets/brand               the brand's files, under their own licence
deploy/                    a host's installer and compose file; deploy/dev for development
```

## Running a host

The Images workflow publishes multi-architecture images (`linux/amd64`,
`linux/arm64`) to GitHub's container registry: every `vX.Y.Z` tag as
`:X.Y.Z` and `:stable`, and `main`, when the workflow is run by hand
(`gh workflow run images.yml`), as `:edge`.

A host runs the released images. [`deploy/install.sh`](deploy/install.sh)
sets one up on Raspberry Pi OS (64-bit), Debian or Ubuntu, and with
`--uninstall` removes it again, the home's data included.
[The install guide](https://docs.meetsanctum.com/install/) has the steps a
person takes, from a blank card to a first device.

On a machine that already has Docker, the same by hand is
[`deploy/compose.yml`](deploy/compose.yml):

```sh
cp deploy/.env.example deploy/.env
docker compose -f deploy/compose.yml up -d
```

Compose starts only the manager, which creates and updates the core's
container and updates itself.

To run your own builds on a Raspberry Pi through the same update path, use
`pnpm host:setup` once and then `pnpm host:push` (settings in
`deploy/dev/.env.example`). A dev host is set up this way, not with the
installer, which refuses one.

## Licences

The product is under the AGPL, and `packages/` and `catalog/apps/` are under
the Apache License; the [README](README.md#licences) says which is which. The
brand's files in `assets/brand` are not open source, and a fork needs a name
and logo of its own ([TRADEMARKS.md](TRADEMARKS.md)).
