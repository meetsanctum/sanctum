# Sanctum Agent Notes

How to work in this repository. [CONTRIBUTING.md](CONTRIBUTING.md) has the
setup, the commands and the layout; these notes are the rules.

## Project Shape

- Monorepo managed with `pnpm` and Turbo.
- `apps/core` — the core: modules, app host, permission gate, client gateway.
- `apps/manager` — the privileged process: Docker, updates and rollback,
  backups, TLS, USB and serial. No domain logic.
- `apps/client` — the React + Vite shell (dashboards, the sidebar, Apps and
  system app UIs), wrapped by the desktop app.
- `apps/desktop` — the Electron desktop app: discovery of hosts and the
  token's storage around the built client.
- `apps/website` — the public landing page: static HTML and CSS built with
  Vite.
- `packages/app-sdk` — `defineApp`, `defineAction`, `defineEvent`, schemas.
- `packages/ui-sdk` — what apps' pages import: `defineAppUi`, the typed app
  client, the design components they share with the shell.
- `packages/auth-protocol` — what the core's Auth and the clients share: its
  routes' shapes, the sign-in binding, username and password rules.
- `packages/typescript-config` — shared TypeScript settings.
- `catalog/apps/*` — Sanctum apps, driver apps included, one workspace
  package each: `moods`, `natural-light`, `weather` and `zigbee`. An app's UI
  is its package's `./ui` export, which the client bundles.
- `assets/brand` — `@meetsanctum/brand`, the brand's files under their own
  licence: the logo, the app icons, the desktop app's icon and the brand's
  photos.

## Architecture Rules

- Apps depend only on `@meetsanctum/app-sdk` and `@meetsanctum/ui-sdk` plus
  plain libraries — never on `apps/*` or other `catalog/*` packages.
- Apps never call or subscribe to other apps. Cooperation goes through
  workflows and standard intents.
- Shared nouns (people, places and where the home is, devices) belong to the
  core, not to an app. Weather and natural light are apps. So do the pages
  that show places and devices: the sidebar and room and category pages are
  the shell's, and apps add to a room's page only through room sections.
- Every read or write of app data goes through an action with schemas and a
  safety tier.
- What an app brings to the home is declared in its manifest under `provides`
  (entities of declared types, widgets) and published through the core,
  which keeps each app's catalog. Other apps read entities by standard type
  only, never from a named app.
- Clients only ever talk to the core. Only the manager touches Docker, the
  network stack and hardware, and only the core talks to the manager.
- Clients never assume the core served the page: build every core URL with
  `coreUrl()` from `apps/client/src/core-url.ts`, never a bare `/api` path.

## Public Repository

This repository is public. It describes what is built, in the present tense:

- Comments state their reason in place, without pointing at documents
  outside the repository.
- Code, comments, tests, fixtures, commit messages and pull request
  descriptions describe what exists. Example apps in tests are
  `sanctum.example`.
- Copyright lines read "Copyright © 2026 Sanctum"; files name no person.

## Licences

What is under which licence, and what neither covers, is in
[README.md](README.md#licences).

- A new package in `packages/` or `catalog/apps/` is `Apache-2.0`: a copy of
  `packages/app-sdk/LICENSE` and `"license": "Apache-2.0"` in its
  `package.json`. One in `apps/` is `"license": "AGPL-3.0-only"`, under the
  root `LICENSE`.
- Code ported or copied into those Apache packages, and their dependencies,
  carry permissive licences (MIT, BSD, ISC, Apache-2.0 and the like).
- Brand files (logos, app icons, the brand's photos) live only in
  `assets/brand`: code imports them from `@meetsanctum/brand`, and
  `packages/` and `catalog/apps/` hold none. Files from others, such as the
  Unsplash backdrops, keep their licences and credits in a README beside
  them, listed in the README's Licences.

## Working Rules

- Preserve unrelated local changes. Do not revert or rewrite files you did not
  touch for the current task.
- Prefer the repo's existing patterns over new abstractions.
- Use `rg` for searching.
- Avoid cosmetic refactors. Moving code means moving ownership, not adding
  re-export wrappers.
- Refactor source or test files that grow beyond about 800 lines when touching
  them, into focused modules by domain or responsibility. Generated files,
  migrations, snapshots, lockfiles and vendored assets are exempt.
- Do not add empty placeholder packages. A package appears with its first real
  code.
- Clean up any dev servers, watchers or other services started during an agent
  loop before finishing the turn, unless the user asks to keep them running.
  `pnpm dev:stop` stops a worktree's stack, and `pnpm dev:down` removes it.

## UI Guidelines

- Calm, glanceable, flat, with frosted glass only for what floats over a page
  (tiles, widgets, the floating sidebar and veils) and for the sheet of the
  screens before it.
- Carbon and White are the only background colours apart from a dashboard's
  own and the blurred backdrop of the screens before it. A dashboard's
  background shows only behind dashboards and room and category pages;
  apps' pages are full bleed Carbon or White by the device's mode, with
  filled cards.
- The window's frame, which the docked sidebar sits on, is in the page's
  colour, a place's background deepened or the mode's card fill, and on the
  Mac the system's sidebar material through it, not a live blur.
- Electric blue only for what you can press (buttons, links, active states),
  never for anything else.
- Inter; sentence case everywhere, never all caps (acronyms such as OS keep
  their capitals); no dividing lines; corners from the `--radius` scale,
  nothing pill-shaped.
- Widget titles in the app's colour, but room sections' headings neutral like
  the shell's own; one primary action per widget at most.
- One layout for tablets, desktops and phones: nothing reachable only by
  touch (a tap on empty space, a swipe, a long press), since a mouse never
  finds it.
- Build client UI from shadcn components, styled with Tailwind utilities on
  the theme's tokens (`bg-background`, `text-muted-foreground`, `rounded-md`).
  Those apps' pages use live in `packages/ui-sdk/src/components/ui`; those
  only the shell uses stay in `apps/client/src/components/ui`. Add a missing
  component with the shadcn CLI in the package that needs it, then format it
  with Prettier.
- Every button is `Button` from `@meetsanctum/ui-sdk`, styled only by its
  `variant` and `size`; a `className` places it, never restyles it. A look it
  lacks becomes a new variant or size there, not an override at the call
  site.
- Apps' pages import only `@meetsanctum/ui-sdk` and React, plus types from
  `@meetsanctum/app-sdk`; the shell holds no app's logic.
- People are identified by avatar and identity colour, consistently.
- A shared tablet and a signed-in person, adult or child, see and do the
  same: every screen and widget has one state, gated by nothing, and there is
  no per-person data.
- Keep layout stable and lightweight: live `backdrop-filter` only for the
  dashboard's frosted glass, animate only `transform` and `opacity`. The
  knot loader drawing its line and the page's edge going with the sidebar
  are the exceptions.
- Destructive operations must be explicit, gated and unsurprising.
- Never hard-code the product name in UI text; import `productName` from
  `apps/client/src/brand.ts`.
- UI text never names the machine: it says Sanctum, and a home where a
  sentence counts or picks one, never box, host or core. Docs and code call
  the machine the host and the service the core; home in code means only the
  home id, the household's data a host serves.

## Database And Migrations

- Each app owns one SQLite file; the core owns its own database, `core.db`.
  Only what hosts an app opens its file, and app code goes through
  `ctx.storage`. In an app's container that is the SDK's rule, not a wall, so
  the core treats its socket as untrusted: check what arrives there as if
  anything could have sent it.
- Schemas are written in Drizzle; migrations are generated with Drizzle Kit.
  The core's tables live in each module's `schema.ts`; generate its
  migrations with `pnpm --filter @meetsanctum/core db:generate --name <change>`.
- Do not manually create or edit migration SQL, journal files or snapshot
  files. Do not edit existing generated migrations.

## App Contracts

- Each catalog app commits its static manifest, `sanctum-app.json`. After
  changing an app's manifest, actions or events, run `pnpm manifest` and
  commit the result; never edit the file by hand. The app's `pnpm test` fails
  while it is stale.
- Removing or renaming an action, event, setting or widget needs a new major
  version, or below 1.0 a new minor; `pnpm manifest` refuses it otherwise, and
  raises the oldest of the app's pages that work with it once it does.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm format:check
```

`pnpm test:containers` runs real stacks and images in Docker and takes minutes:
run it when changing the manager, `deploy/` or how apps are packaged, where CI
runs it too.

Use focused `pnpm --filter <package> <task>` runs while iterating, then the
full set before finishing.
