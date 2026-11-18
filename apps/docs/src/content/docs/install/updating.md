---
title: Updating
description: Update Sanctum from the Mac app, rebuild the app to match, and the edge channel.
sidebar:
  order: 2
---

In the Mac app, Settings → System shows the version and its channel, such as
"0.1.0 · Stable channel", with **Update** beside it. An update backs up your
home's data, restarts with the new version, and goes back by itself if the
new version does not start. The home's controls are away for a minute or
two.

The Mac app carries its own screens, so after an update quit the app and
build it again. In the `sanctum` folder on the Mac, fetch the new releases
and select the tag matching the version Settings → System now shows (for
example, `v0.1.0` for version `0.1.0`):

```sh
git fetch origin --tags
git checkout v0.1.0
pnpm install
pnpm --filter @meetsanctum/desktop package
open apps/desktop/release
```

Open the new disk image and replace Sanctum in Applications.

The installer takes `--channel edge` for the newest build from `main` in
place of a release:

```sh
curl -fsSL https://raw.githubusercontent.com/meetsanctum/sanctum/main/deploy/install.sh | sudo bash -s -- --channel edge
```

A home stays on the channel it was installed on.

For an edge install or update, build the Mac app from the same commit as
the running home. On the machine, read that commit:

```sh
sudo docker inspect sanctum-core --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

After fetching on the Mac, use `git checkout` with that commit in place of
the release tag in the build commands above. Edge images are published by
hand, so the latest code on `main` may be newer than the running home.
