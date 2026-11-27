import {
  appColors,
  type AppInfo,
  type StaticManifest,
} from "@meetsanctum/app-sdk";
import { Button, type LiveFeed } from "@meetsanctum/ui-sdk";
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
const actionBlue = "#3e6ae1";

function isBackdropColor(color: unknown): color is string {
  return (
    typeof color === "string" &&
    hex.test(color) &&
    color.toLowerCase() !== actionBlue
  );
}

function defaultPageIcon(app: AppInfo) {
  return app.icon && appColors.includes(app.icon.color) ? app.icon : plainIcon;
}

/**
 * The page's background: the app's own colours where it names them, darkest
 * at the bottom left under its name, else its icon's colour deepened.
 */
export function appBackdrop(app: AppInfo) {
  const backdrop = app.backdrop;
  if (
    backdrop &&
    isBackdropColor(backdrop.from) &&
    isBackdropColor(backdrop.to)
  ) {
    return `${shade}, linear-gradient(to top right, ${backdrop.from}, ${backdrop.to})`;
  }
  const color = `var(--${defaultPageIcon(app).color})`;
  // Deepened toward Carbon at both ends, never lightened, so even a light
  // icon colour such as sun keeps the top bar's white buttons at 3:1.
  return `${shade}, linear-gradient(to top right, color-mix(in srgb, ${color} 30%, var(--carbon)), color-mix(in srgb, ${color} 70%, var(--carbon)))`;
}

export function DefaultAppPage(props: {
  app: AppInfo;
  live: LiveFeed;
  deviceCount: number;
  openDevices: () => void;
  openSettings: () => void;
  openStatus: () => void;
}) {
  const { app } = props;
  const manifest = useManifest(app.id, props.live);
  const summary =
    typeof manifest?.summary === "string" ? manifest.summary.trim() : "";
  const isDriver = !!manifest?.driver;
  return (
    <div className="flex grow flex-col-reverse justify-between gap-8 sm:flex-row sm:items-end sm:p-10">
      <div className="flex flex-col items-start gap-1">
        <h1 className="m-0 text-[34px] leading-10 font-medium tracking-[-0.01em] sm:text-[44px] sm:leading-[52px]">
          {app.name}
        </h1>
        {/* In the ink, not the secondary grey: the app's first colour is
            dark enough for white at 4.5:1, not for grey. */}
        <p className="m-0 text-[15px] leading-5">Version {app.version}</p>
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
        {(summary || isDriver) && (
          <section className="flex flex-col gap-4 rounded-lg bg-card/80 p-6">
            <div className="flex items-center gap-3">
              <AppIcon
                icon={defaultPageIcon(app)}
                className="size-11 [&_svg]:size-6"
              />
              <h2 className="m-0 text-[15px] leading-5 font-medium">
                What it does
              </h2>
            </div>
            {summary && <p className="m-0 text-[17px] leading-6">{summary}</p>}
            {isDriver && (
              <Button className="self-start" onClick={props.openDevices}>
                Show devices
              </Button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

// The page remounts for a new build. A live refresh retries a failed read.
function useManifest(id: string, live: LiveFeed) {
  const [manifest, setManifest] = useState<StaticManifest>();
  useEffect(() => {
    let isCurrent = true;
    let needsManifest = true;
    const load = () => {
      if (!needsManifest) return;
      needsManifest = false;
      void coreJson<StaticManifest>(
        `/api/apps/${encodeURIComponent(id)}/manifest`,
      )
        .then((next) => {
          if (isCurrent) setManifest(next);
        })
        .catch(() => {
          needsManifest = true;
        });
    };
    load();
    const unsubscribe = live.subscribe({ refresh: load });
    return () => {
      isCurrent = false;
      unsubscribe();
    };
  }, [id, live]);
  return manifest;
}
