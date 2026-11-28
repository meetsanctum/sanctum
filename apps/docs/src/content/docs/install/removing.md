---
title: Removing Sanctum
description: Remove Sanctum and its data from the machine, and what stays behind.
sidebar:
  order: 5
---

The installer also removes what it set up. On the machine, run:

```sh
curl -fsSL https://raw.githubusercontent.com/meetsanctum/sanctum/main/deploy/install.sh | sudo bash -s -- --uninstall
```

It says what goes and waits for you to type `remove`. Your home's data goes
with it: its people, rooms, devices, automations, history and backups. None
of it can be brought back, and a Sanctum installed again afterwards is a new
home.

What it removes:

- **In Docker**: Sanctum's containers, volumes and networks, and the images
  they ran, except an image another container still uses.
- **`/opt/sanctum`**: `compose.yml` and `.env`, and the folder if nothing
  else is in it.
- **On a laptop**: `/etc/systemd/logind.conf.d/sanctum.conf`, and the sleep,
  suspend and hibernate targets are unmasked, so it sleeps again as its
  system decides.

What it leaves:

- **Docker**, with its package repository.
  [Docker's instructions](https://docs.docker.com/engine/install/debian/#uninstall-docker-engine)
  remove it.
- **On a Raspberry Pi**: `cgroup_enable=memory` in
  `/boot/firmware/cmdline.txt` (or `/boot/cmdline.txt` on older systems),
  which other containers may count on. To take it out, delete that one word
  from the file's single line and restart the Pi.
- **How much the system holds before writing to the disk**, as Sanctum set
  it, until the machine next restarts.
- **Your devices.** Lights, switches and sensors stay joined to a Zigbee
  network that is gone: reset each, as its instructions say, before it joins
  another.
- **The Mac app.** It says "Your home is not answering"; **Choose another
  home** there has it forget this one. Then move Sanctum from Applications
  to the Bin.

Running the command again finishes a removal that was cut short. With no
terminal to answer on, as in a script, add `--yes` after `--uninstall` to
remove without being asked.

It removes only a Sanctum this installer set up. One started by hand from
`deploy/compose.yml` it leaves alone, and says so.
