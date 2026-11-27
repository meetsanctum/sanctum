---
title: What the installer changes
description: Everything the installer adds to the machine.
sidebar:
  order: 4
---

- **Docker**, only where it is missing: Docker's package repository
  (`/etc/apt/sources.list.d/docker.list`, with its key in
  `/etc/apt/keyrings/docker.asc`) and from it Docker Engine, its command
  line, containerd and the Compose plugin.
- **`/opt/sanctum`**: `compose.yml`, which starts Sanctum's manager, and
  `.env`, which holds the channel.
- **In Docker**: containers, volumes and networks named `sanctum` or
  starting with `sanctum-`. Your home's data is in those volumes.
- **On a Raspberry Pi** whose system gives containers no memory limits:
  `cgroup_enable=memory` at the end of `/boot/firmware/cmdline.txt` (or
  `/boot/cmdline.txt` on older systems), and one restart.
- **On a laptop**: `/etc/systemd/logind.conf.d/sanctum.conf`, which has the
  system ignore the lid, and the sleep, suspend and hibernate targets
  masked, so it never sleeps.

Once it runs, Sanctum also sets how much the system may hold in memory
before writing it to the disk (`vm.dirty_background_bytes` and
`vm.dirty_bytes`). It starts with a 32 MiB limit and targets
about two seconds of writes when it can measure a single backing disk. The
32 MiB minimum can represent more time on slow storage, and the limit drops
lower when there is little memory available for writes. The system forgets
these settings when it restarts, and Sanctum sets them again as it starts.
