# Installing Sanctum

Sanctum runs on a small computer in your home, and you use it from the Mac
app. This guide takes a Raspberry Pi, or another Linux machine, from nothing
to a home with its first light in it.

It asks for a terminal twice: one pasted command on the machine, and a few
to build the Mac app, which has no download.

## What you need

- **A machine that stays on.** A Raspberry Pi 4, or another 64-bit machine
  (ARM, Intel or AMD) running Raspberry Pi OS (64-bit), Debian or Ubuntu. An
  old laptop with Debian or Ubuntu Server on it works too.
- **A Zigbee USB stick** that Zigbee2MQTT supports. The Nabu Casa ZBT-2 and
  the Dresden Elektronik ConBee III are recognised by themselves; so are
  other Nabu Casa and Silicon Labs sticks and other ConBee and RaspBee ones.
  [Any other](#zigbee-does-not-start) takes one command.
- **A Mac with Apple silicon**, for the Mac app, with Git, Node.js 24 or
  newer and pnpm 10 to build it.
- **One home network** for the machine and the Mac: the same Wi-Fi or the
  cable behind it, not a guest network.

## 1. Prepare the machine

A machine that already runs Debian or Ubuntu needs nothing: open a terminal
on it, or one over SSH, and go on to step 2.

### A Raspberry Pi with a blank card

1. On your Mac, open [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
   and choose **Raspberry Pi OS Lite (64-bit)**, listed under the other
   Raspberry Pi OS versions.
2. In Imager's settings for the system, set a hostname (say `sanctum`), a
   username and a password, your Wi-Fi if the Pi has no network cable, and
   turn on SSH.
3. Write the card, put it in the Pi and plug the Pi in. Its first start
   takes a few minutes.
4. From the Mac's Terminal, connect with the username and hostname you set:

   ```sh
   ssh you@sanctum.local
   ```

### An old laptop

Install Debian or Ubuntu Server on it from a USB stick, with the laptop on a
network cable or its Wi-Fi set up in the installer. Sanctum's installer then
keeps it awake with its lid closed.

## 2. Install Sanctum

On the machine, run:

```sh
curl -fsSL https://raw.githubusercontent.com/meetsanctum/sanctum/main/deploy/install.sh | sudo bash
```

It takes a few minutes, most of them downloading, and ends with:

```
==> Sanctum is running
Open the Sanctum app on your Mac: it finds your home on this network.
```

A Raspberry Pi then says it restarts in 10 seconds, once, to turn on a
setting its system leaves off. Sanctum comes back by itself.

Running the command again is safe: it leaves a running Sanctum alone and
finishes an install that was cut short.
[What the installer changes](#what-the-installer-changes) lists everything
it touches.

## 3. Plug in the Zigbee stick

Plug the stick into the machine. Zigbee starts by itself within a minute,
before or after the next steps. Plug in one stick only: with several,
Sanctum waits for you to unplug the ones it shouldn't use.

## 4. Build the Mac app

On the Mac:

```sh
git clone https://github.com/meetsanctum/sanctum.git
cd sanctum
git checkout "$(git describe --tags --abbrev=0 origin/main)"
corepack enable
pnpm install
pnpm --filter @meetsanctum/desktop package
open apps/desktop/release
```

The third line takes the code of the newest release, the version the
installer put on your machine. The last opens the folder with the disk
image, `Sanctum-<version>-arm64.dmg`: open it and drag Sanctum into
Applications.

Built on your own Mac, the app opens without a warning. On a Mac it was
copied to, macOS holds it back the first time: System Settings → Privacy &
Security → Open Anyway lets it start.

When macOS asks whether Sanctum may find devices on your local network,
allow it. That is how the app finds your home.

## 5. Set up your home

1. Open Sanctum. Under **Choose your home** it lists **New home, ready to set
   up**, with the machine's address. Choose **Set up**.
2. Enter your name, a colour, a username and a password, and choose **Set
   up**. You are the first person in the home.
3. The dashboard opens on **Set up your home**, three steps in any order:
   - **Set where the home is**, for the weather and for lights that follow
     daylight.
   - **Add your rooms**, so each device is named after the room it is in.
   - **Add lights, switches and remotes**. Choose **Add devices**, then
     switch a new device on or reset it, as its instructions say. New
     devices can join for about four minutes; each shows up as it joins, to
     name and put in a room.

Set your home up soon after installing. Until someone has, anyone on your
network who opens the app can.

On another Mac, the app lists your home with **Sign in**. A person signs in
with their own username and password; a Mac the household shares chooses
**This is a shared device** and is approved from a device that is already
in.

## Updating

In the Mac app, Settings → System shows the version and its channel, such as
"0.1.0 · Stable channel", with **Update** beside it. An update backs up your
home's data, restarts with the new version, and goes back by itself if the
new version does not start. The home's controls are away for a minute or
two.

The Mac app carries its own screens, so after an update build it again from
the new release, as in step 4.

The installer takes one option, for the newest build from `main` in place of
a release:

```sh
curl -fsSL https://raw.githubusercontent.com/meetsanctum/sanctum/main/deploy/install.sh | sudo bash -s -- --channel edge
```

A home stays on the channel it was installed on.

## When something isn't right

### The installer stops

It says why in one sentence. The ones that take a step from you:

- **"Sanctum needs a 64-bit system."** On a Raspberry Pi, write the card
  again with Raspberry Pi OS (64-bit).
- **"Install Docker Engine with its Compose plugin"**, on a system other
  than Raspberry Pi OS, Debian and Ubuntu: follow
  [Docker's instructions](https://docs.docker.com/engine/install/) for it,
  then run the installer again.
- **"Could not download…"**: check the machine's internet connection, then
  run it again.
- **"Sanctum did not start within 15 minutes."** See what it was doing, and
  run the installer again once the cause is gone:

  ```sh
  sudo docker logs sanctum-manager
  ```

### The Mac app finds no home

It says "No home found on this network." and keeps looking, so a home that
appears later is listed by itself.

- Give the machine a few minutes after installing or restarting.
- Check that the Mac is on the same network as the machine, not a guest
  network, and that the router lets devices find each other.
- In System Settings → Privacy & Security → Local Network, check that
  Sanctum is allowed.
- On the machine, check that Sanctum runs. This lists `sanctum-manager` and
  `sanctum-core` among others:

  ```sh
  sudo docker ps
  ```

- A firewall on the machine has to let in UDP port 5353, which is how the
  app finds your home, and TCP port 4100, which is how it talks to it.

### Zigbee does not start

Settings → System → Status says what is missing: no stick plugged in, or
several. With one stick in and Zigbee still not running, the stick's type is
one Sanctum does not recognise by itself. On the machine, list the sticks it
sees:

```sh
sudo docker exec sanctum-manager node dist/cli.js coordinator
```

Then choose yours by its path, with the adapter type Zigbee2MQTT names for
it (`zstack`, `ember`, `deconz`, `zigate` or `zboss`):

```sh
sudo docker exec sanctum-manager node dist/cli.js coordinator choose /dev/serial/by-id/usb-… zstack
```

## What the installer changes

- **Docker**, only where it is missing: Docker's package repository
  (`/etc/apt/sources.list.d/docker.list`, with its key in
  `/etc/apt/keyrings/docker.asc`) and from it Docker Engine, its command
  line, containerd and the Compose plugin.
- **`/opt/sanctum`**: `compose.yml`, which starts Sanctum's manager, and
  `.env`, which holds the channel.
- **In Docker**: containers, volumes and networks named `sanctum` or
  starting with `sanctum-`. Your home's data is in those volumes.
- **On a Raspberry Pi** whose system gives containers no memory limits:
  `cgroup_enable=memory` at the end of `/boot/firmware/cmdline.txt`, and one
  restart.
- **On a laptop**: `/etc/systemd/logind.conf.d/sanctum.conf`, which has the
  system ignore the lid, and the sleep, suspend and hibernate targets
  masked, so it never sleeps.
