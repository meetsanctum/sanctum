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
pnpm dev          # the manager and core in Docker, client on :5173, website on :5174
pnpm dev:seed     # a claimed home with rooms and fake lights
pnpm dev:status   # the core's address, and any other stacks
pnpm dev:stop     # stop this worktree's stack
pnpm dev:down     # remove this worktree's stack and its data
```

`pnpm dev` runs a stack for each checkout or worktree, on a port of its own.
The client's dev server proxies `/api` to the core. To call the core
cross-origin instead, as the desktop app does, point the client at the core
and allow the client's origin:

```sh
VITE_SANCTUM_CORE_URL=http://127.0.0.1:<port> \
CORE_ALLOWED_ORIGINS=http://localhost:5173 pnpm dev
```

`pnpm dev` runs the core over plain HTTP, for development only. On a host the
core serves only HTTPS, with a certificate the manager signs as the host's
certificate authority, and the desktop app pins that authority. The desktop
app finds hosts on the network and talks to them cross-origin; see
[apps/desktop](apps/desktop/README.md).

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
  Zigbee2MQTT), backs up before each update and rolls back when a new version
  isn't healthy.
- **The shell** (`apps/client`) is the React app behind every screen. Apps'
  pages are built with `@meetsanctum/ui-sdk` and bundled into it.

## Repository layout

```
apps/core                  the core: modules, app host, client gateway
apps/manager               the privileged process: Docker, updates, backups
apps/client                the React + Vite shell
apps/desktop               the Electron desktop app
apps/website               the landing page
packages/app-sdk           defineApp, defineAction, defineEvent, schemas
packages/ui-sdk            what apps' pages import: components, the app client
packages/auth-protocol     Auth's routes, sign-in binding and rules
packages/typescript-config shared TypeScript settings
catalog/apps/*             Sanctum's apps, driver apps included
assets/brand               the brand's files, under their own licence
deploy/                    the compose file for a host; deploy/dev for development
```

## Running a host

The Images workflow publishes multi-architecture images (`linux/amd64`,
`linux/arm64`) to GitHub's container registry: every `vX.Y.Z` tag as
`:X.Y.Z` and `:stable`, and `main`, when the workflow is run by hand
(`gh workflow run images.yml`), as `:edge`.

A host runs the released images. On a Raspberry Pi with Raspberry Pi OS
(64-bit), or another 64-bit machine with Debian or Ubuntu,
[`deploy/install.sh`](deploy/install.sh) sets one up:

```sh
curl -fsSL https://raw.githubusercontent.com/meetsanctum/sanctum/main/deploy/install.sh | sudo bash
```

It installs Docker where it is missing, turns on the memory limits a
Raspberry Pi leaves off (the Pi restarts once), keeps a laptop awake with its
lid closed, and starts Sanctum from `/opt/sanctum`. Add `-s -- --channel edge`
after `bash` for the latest build from `main` instead of a release. Running
it again is safe.

On a machine that already has Docker, the same by hand is
[`deploy/compose.yml`](deploy/compose.yml):

```sh
cp deploy/.env.example deploy/.env
docker compose -f deploy/compose.yml up -d
```

Compose starts only the manager, which creates and updates the core's
container and updates itself. To run your own builds on a Raspberry Pi
through the same update path, use `pnpm host:setup` once and then
`pnpm host:push` (settings in `deploy/dev/.env.example`).

## Licences

The product is under the AGPL, and `packages/` and `catalog/apps/` are under
the Apache License; the [README](README.md#licences) says which is which. The
brand's files in `assets/brand` are not open source, and a fork needs a name
and logo of its own ([TRADEMARKS.md](TRADEMARKS.md)).
