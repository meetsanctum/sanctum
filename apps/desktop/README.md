# Desktop app

The Electron desktop app. It wraps the built `apps/client`, loads it from its
own origin, `app://sanctum`, and, like every client, talks only to the core.

- **Finding the host:** the main process browses the home network for
  `_sanctum._tcp` and hands the hosts it finds to the page, with their host
  and home ids. Nobody types an address.
- **The token:** the main process keeps the paired host's id, its home's id,
  last address, client token and its CA's pin and certificate in `host.json`
  in the app's data folder, encrypted with `safeStorage`. The page reads it,
  without the certificate, through the preload bridge, `window.sanctumShell`
  (`Shell` in `apps/client/src/shell.ts`).
- **Preferences:** what the client keeps about how it shows the home, such as
  the dashboard on show, is in `preferences.json` in the app's data folder
  (`src/preferences.ts`), through the same bridge. The page's own storage
  would not keep it: its session is in memory and is replaced whenever trust
  changes (below).
- **Checking the host:** the page runs in a session of its own, in memory,
  whose `setCertificateVerifyProc` checks every HTTPS request and WebSocket
  against the stored pin (`src/trust.ts`, `src/host-chain.ts`). At first
  contact it holds the first CA it sees as the only candidate and lets no
  `Authorization` header through until a claim, sign-in or pairing saves it.
  Chromium keeps every decision for the life of a session, so starting or
  abandoning a first contact moves the page to a fresh session, in a new
  window where the old one was, which comes back to the same view
  (`src/pages.ts`). The client ships its fonts, so no server is left to the
  system's roots. Before another request or WebSocket, a cached certificate
  decision whose dates no longer fit the clock also gets a fresh session.
  This reconnects to the stored home, or returns an unfinished first contact
  to choosing a home. Date refusals are retried once a corrected clock makes
  them valid.
- **The core's CORS allowlist** must include `app://sanctum`. On a host the
  manager passes it in the core container's settings.

## Running it

```sh
pnpm --filter @meetsanctum/desktop... build   # the client and the app
pnpm --filter @meetsanctum/desktop start
```

On macOS the app needs Local Network access to find hosts: the system asks
the first time, and the setting is in System Settings → Privacy & Security →
Local Network. Without it, sending to the mDNS group fails and discovery
finds nothing. Discovery also stays on the local network segment, unless the
router relays mDNS.

Where discovery cannot reach the host during development, give the app the
host's URL; it lists the host that answers there next to the ones it finds. A
packaged app ignores this, since people never type an address. Its answer is
a hint like an announcement: the page checks the host's certificate before it
sends anything.

```sh
SANCTUM_DEV_HOST_URL=https://192.168.3.222:4100 pnpm --filter @meetsanctum/desktop start
```

An unpackaged app also talks plain HTTP to a core under `pnpm dev`
(`SANCTUM_DEV_HOST_URL=http://127.0.0.1:<port>`, from `pnpm dev:status`), with
no pin. A packaged app only reaches hosts over HTTPS and WSS, and keeps no
host over plain HTTP.

To run a second copy beside the one paired with your host, for example
against a test host, give it a data folder of its own:

```sh
pnpm --filter @meetsanctum/desktop exec electron . --user-data-dir="$(mktemp -d)"
```

## The Mac app

On a Mac, this builds the client and the app and makes a disk image,
`apps/desktop/release/Sanctum-<version>-arm64.dmg`:

```sh
pnpm --filter @meetsanctum/desktop package
```

Open the image, drag Sanctum into Applications, and start it from there, the
Dock, Launchpad or Spotlight like any other app.

- **What is in it:** `scripts/package.ts` bundles the main process and its
  dependencies into one file with esbuild, puts the preload and the built
  client beside it (`src/main.ts` finds the client there), and has
  electron-builder make `Sanctum.app` and the image from that, with no
  node_modules. It is for Apple silicon only.
- **Name and version:** the name is `productName` from
  `apps/client/src/brand.ts`, the version this package's. After the version,
  the About panel shows the commit the app was built from, with `-dirty`
  when the working tree had changes. macOS's build number
  (`CFBundleVersion`), which must be a number, is the count of commits.
- **The menu bar** is `src/menu.ts`; only an unpackaged app reloads and has
  the developer tools.
- **Signing:** the app is signed ad hoc and is not notarised. Built on this
  Mac, it opens without a word. A copy that arrives from elsewhere (a
  download, AirDrop) is held back: macOS says "“Sanctum” Not Opened", and
  System Settings → Privacy & Security → Open Anyway lets it start. Each new
  build has a new signature, so macOS may ask again for the keychain key,
  "Sanctum Safe Storage" (choose Always Allow).
- **Local Network access:** macOS keys it to the executable's Mach-O UUID,
  which Electron's executables share with every app built from them, so
  Sanctum's would be whatever macOS decided for "Electron". Packaging gives
  them UUIDs of their own, the same in every build (`scripts/macho.ts`).
  Started from a terminal, the app has the terminal's access instead.
- **Fuses:** the packaged app cannot run as plain Node or take
  `NODE_OPTIONS` or `--inspect`, and it loads only its own checked asar,
  since it holds the keychain key for the home's token.
- **Its data:** the packaged app uses the same data folder and keychain key
  as `pnpm start`, so it opens on the home the unpackaged app is paired
  with. To try a build without touching that pairing, start it with a data
  folder of its own:

  ```sh
  /Applications/Sanctum.app/Contents/MacOS/Sanctum --user-data-dir="$(mktemp -d)"
  ```

### The brand's artwork

`resources/dmg-background.tiff` and the logo files in `assets/brand`, the
app's icon `sanctum-macos-icon.icns` among them, are committed. They are all
drawn from one geometry, `scripts/artwork.ts`; to change them, edit it and
run, on a Mac:

```sh
pnpm --filter @meetsanctum/desktop artwork
```

It draws them with AppKit, as macOS draws them
([assets/brand/README.md](../../assets/brand/README.md), How the files were
made). The icon is the White knot on Carbon in the macOS icon shape, 14 units
of the tile's 26 at a whole number of pixels per unit in every image. macOS
26 and later frame a classic icon's own 16 and 32 px images in grey, so the
icon has none: macOS shrinks the 128 px image for those sizes, whose knot is
4 px to a unit, so it stays sharp at 32 and 16 on a 1× display. The glass,
dark, tinted and clear looks of macOS 26 need an Icon Composer `.icon`, which
electron-builder compiles only where Xcode 26 is installed.
