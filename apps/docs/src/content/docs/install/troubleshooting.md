---
title: When something isn't right
description: What to do when the installer stops, the Mac app finds no home or Zigbee does not start.
sidebar:
  order: 3
---

## The installer stops

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

## The Mac app finds no home

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
  Smart speakers fetch what Sanctum says on TCP port 4180, over plain HTTP
  from your home's network only.

## Zigbee does not start

Settings → System says what is missing: no stick plugged in, or
several. If it asks you to choose the stick's adapter type, Sanctum does not
recognise that type by itself. On the machine, list the sticks it sees:

```sh
sudo docker exec sanctum-manager node dist/cli.js coordinator
```

Then choose yours by its path, with the adapter type Zigbee2MQTT names for
it (`zstack`, `ember`, `deconz`, `zigate` or `zboss`):

```sh
sudo docker exec sanctum-manager node dist/cli.js coordinator choose /dev/serial/by-id/usb-… zstack
```
