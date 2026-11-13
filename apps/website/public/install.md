# Setting up Sanctum, for an AI agent

You are an AI agent, and a person has asked you to help them set up Sanctum:
open source home automation that runs on a small computer in their home and
is used from a Mac app. This page tells you each step, what to check before
it, and what only the person can do.

[The install guide](https://github.com/meetsanctum/sanctum/blob/main/docs/install.md)
has every step in full. Where this page and the guide differ, follow the
guide and say so.

## How to work

- Guide, don't take over. Say what a step does in one plain sentence before
  it, and show each command before you run it.
- Ask before any command that uses `sudo`, and before anything that writes
  outside the person's home folder or the `sanctum` folder you clone.
- Never ask for a password in the chat. Where a command asks for one, the
  person types it in their own terminal.
- Run only the commands on this page and in the install guide. If a step
  fails, stop, show what it said and what it means, and ask before trying
  something else.
- Never run the installer with `--uninstall` unless the person asks to
  remove Sanctum. It deletes their home's data for good.
- These steps stay with the person: writing the memory card, plugging in the
  machine and the Zigbee stick, typing passwords, answering macOS prompts,
  and everything inside the Sanctum app.

## Ask first

Find out, one question at a time:

1. Which machine will Sanctum run on? A Raspberry Pi with at least 2 GB of
   memory, or another 64-bit machine (ARM, Intel or AMD) with Raspberry Pi
   OS (64-bit), Debian or Ubuntu. It stays on all the time.
2. Is its system already installed, and can they reach it: a terminal on
   it, or SSH with a username and its name or address?
3. Do they have a Zigbee USB stick? The Nabu Casa ZBT-2 and the Dresden
   Elektronik ConBee III are recognised by themselves.
4. Is the Mac you are running on the one that will use Sanctum? It needs
   Apple silicon, and it has to be on the same home network as the machine,
   not a guest network.

## 1. Prepare the machine

Skip this if the machine already runs Debian, Ubuntu or Raspberry Pi OS
(64-bit).

For a Raspberry Pi with a blank card, the person does this, with you
talking them through it:

1. Open [Raspberry Pi Imager](https://www.raspberrypi.com/software/) on the
   Mac and choose **Raspberry Pi OS Lite (64-bit)**, listed under the other
   Raspberry Pi OS versions.
2. In Imager's settings for the system, set a hostname (say `sanctum`), a
   username and a password, the Wi-Fi if the Pi has no network cable, and
   turn on SSH.
3. Write the card, put it in the Pi and plug the Pi in. Its first start
   takes a few minutes.

## 2. Reach the machine

Check that it answers, with the username and hostname they set:

```sh
ssh you@sanctum.local 'uname -m && free -m'
```

`uname -m` says `aarch64` or `x86_64` on a 64-bit system. `free -m` shows
the memory: the total should be about 2,000 MB or more.

If SSH asks for a password, have the person run the commands of the next
step in their own terminal while you tell them what to type, or have them
set up an SSH key first.

A fresh Debian may have no `curl`:

```sh
sudo apt-get update
sudo apt-get install -y curl ca-certificates
```

## 3. Install Sanctum

On the machine, with the person's go-ahead:

```sh
curl -fsSL https://raw.githubusercontent.com/meetsanctum/sanctum/main/deploy/install.sh | sudo bash
```

It takes a few minutes, most of them downloading, and ends with:

```
==> Sanctum is running
Open the Sanctum app on your Mac: it finds your home on this network.
```

A Raspberry Pi may then say it restarts in 10 seconds, once. Sanctum comes
back by itself. Running the command again is safe: it leaves a running
Sanctum alone and finishes an install that was cut short.

If it stops, it says why in one sentence:

- **"Sanctum needs a 64-bit system."** On a Raspberry Pi the card has to be
  written again with Raspberry Pi OS (64-bit).
- **"Install Docker Engine with its Compose plugin"**: on a system other
  than Raspberry Pi OS, Debian and Ubuntu, follow
  [Docker's instructions](https://docs.docker.com/engine/install/), then
  run the installer again.
- **"Could not download…"**: check the machine's internet connection, then
  run it again.
- **"Sanctum did not start within 15 minutes."** Look at
  `sudo docker logs sanctum-manager`, and run the installer again once the
  cause is gone.

## 4. The Zigbee stick

Ask the person to plug one stick into the machine. Zigbee starts by itself
within a minute. With several sticks plugged in, Sanctum waits until only
the one to use is left.

## 5. Build the Mac app

The app is built on the Mac. Check what is there first:

```sh
uname -m          # arm64
git --version
node --version    # v24 or newer
pnpm --version    # 10
```

If Git, Node.js or pnpm is missing or too old, say which, and ask how the
person wants it installed before installing anything.

Then, in a folder the person chooses:

```sh
git clone https://github.com/meetsanctum/sanctum.git
cd sanctum
git checkout "$(git describe --tags --abbrev=0 origin/main)"
pnpm install
pnpm --filter @meetsanctum/desktop package
open apps/desktop/release
```

The third line takes the code of the newest release, which matches a new
install. The last opens the folder with the disk image,
`Sanctum-<version>-arm64.dmg`. The person opens it and drags Sanctum into
Applications.

## 6. The first start

The person does this in the app. Tell them what to expect:

1. Open Sanctum. When macOS asks whether Sanctum may find devices on the
   local network, allow it: that is how the app finds the home.
2. Under **Choose your home** the app lists **New home, ready to set up**.
   Choose **Set up**.
3. Enter a name, a colour, a username and a password, and choose **Set
   up**.
4. The dashboard opens on **Set up your home**: set where the home is, add
   rooms, then **Add devices** and switch a new light on or reset it as its
   instructions say.

Remind them to set the home up soon after installing. Until someone has,
anyone on their network who opens the app can.

## When something isn't right

**The app says "No home found on this network."** It keeps looking. Give
the machine a few minutes after installing or restarting. Check that the Mac
is on the same network, not a guest network, and that System Settings →
Privacy & Security → Local Network allows Sanctum. On the machine,
`sudo docker ps` lists `sanctum-manager` and `sanctum-core` when Sanctum
runs. A firewall on the machine has to let in UDP port 5353 and TCP port 4100.

**Zigbee does not start.** In the app, Settings → System → Status says what
is missing. If it asks for the stick's adapter type, list the sticks the
machine sees:

```sh
sudo docker exec sanctum-manager node dist/cli.js coordinator
```

Then choose theirs by its path, with the adapter type Zigbee2MQTT names for
it (`zstack`, `ember`, `deconz`, `zigate` or `zboss`):

```sh
sudo docker exec sanctum-manager node dist/cli.js coordinator choose /dev/serial/by-id/usb-… zstack
```

For anything else, read the install guide's "When something isn't right"
with the person rather than guessing.
