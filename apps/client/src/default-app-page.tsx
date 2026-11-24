import type { AppInfo, StaticManifest } from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

import { AppIcon, plainIcon } from "./app-icon";
import { AppNotice } from "./app-state";
import { coreJson } from "./core-fetch";

// The page the shell draws for an app that brings no page of its own, such
// as a driver: full bleed in the app's colours, its name at the bottom left
// with its version, and on the right what it does, with Show devices for
// one that brings devices. The devices themselves stay in Settings → Devices.

// A faint shade along the top keeps the top bar's white buttons readable
// over light colours.
const shade =
  "linear-gradient(to bottom, rgb(0 0 0 / 24%), rgb(0 0 0 / 0%) 140px)";
const hex = /^#[0-9a-f]{6}$/i;

/**
 * The page's background: the app's own colours where it names them, darkest
 * at the bottom left under its name, else its icon's colour deepened there.
 */
export function appBackdrop(app: AppInfo) {
  const backdrop = app.backdrop;
  if (backdrop && hex.test(backdrop.from) && hex.test(backdrop.to)) {
    return `${shade}, linear-gradient(to top right, ${backdrop.from}, ${backdrop.to})`;
  }
  const color = `var(--${(app.icon ?? plainIcon).color})`;
  return `${shade}, linear-gradient(to top right, color-mix(in srgb, ${color} 30%, var(--carbon)), ${color} 55%, color-mix(in srgb, ${color} 85%, var(--white)))`;
}

export function DefaultAppPage(props: {
  app: AppInfo;
  deviceCount: number;
  openDevices: () => void;
  openSettings: () => void;
  openStatus: () => void;
}) {
  const { app } = props;
  const manifest = useManifest(app);
  return (
    <div className="flex grow flex-col-reverse justify-between gap-8 sm:flex-row sm:items-end sm:p-10">
      <div className="flex flex-col items-start gap-1">
        <h1 className="m-0 text-[34px] leading-10 font-medium tracking-[-0.01em] sm:text-[44px] sm:leading-[52px]">
          {app.name}
        </h1>
        <p className="m-0 text-[15px] leading-5 text-muted-foreground">
          Version {app.version}
        </p>
        <Button variant="outline" className="mt-3" disabled>
          Look for updates
        </Button>
      </div>
      <div className="flex w-full flex-col gap-3 sm:w-96 sm:self-center">
        <AppNotice
          app={app}
          permissionsAre="settings"
          deviceCount={props.deviceCount}
          openSettings={props.openSettings}
          openStatus={props.openStatus}
        />
        <section className="flex flex-col gap-4 rounded-lg bg-card/80 p-6">
          <div className="flex items-center gap-3">
            <AppIcon
              icon={app.icon ?? plainIcon}
              className="size-11 [&_svg]:size-6"
            />
            <h2 className="m-0 text-[15px] leading-5 font-medium">
              What it does
            </h2>
          </div>
          {manifest?.summary && (
            <p className="m-0 text-[17px] leading-6">{manifest.summary}</p>
          )}
          {manifest?.driver && (
            <Button className="self-start" onClick={props.openDevices}>
              Show devices
            </Button>
          )}
        </section>
      </div>
    </div>
  );
}

// What it does and whether it brings devices, from its manifest, read again
// when it moves to another version.
function useManifest(app: AppInfo) {
  const [manifest, setManifest] = useState<StaticManifest>();
  const { id, version } = app;
  useEffect(() => {
    let isCurrent = true;
    coreJson<StaticManifest>(`/api/apps/${encodeURIComponent(id)}/manifest`)
      .then((next) => {
        if (isCurrent) setManifest(next);
      })
      .catch(() => undefined);
    return () => {
      isCurrent = false;
    };
  }, [id, version]);
  return manifest;
}
