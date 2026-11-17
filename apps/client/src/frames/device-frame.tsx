import type { DeviceInfo, TemperatureUnit } from "@meetsanctum/app-sdk";
import { Button, type FrameContext } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { CircleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { NoticeCard } from "../app-state";
import type { HostedApp } from "../apps";
import { KnotLoader } from "../knot-loader";
import { PageDoesntMatch } from "../page-mismatch";
import { possessive, useFrame } from "./use-frame";

// An app's page for a device, in the device's detail, in a frame of its own
// (use-frame.ts). It lies over the detail in Evening, transparent, as tall
// as the page says it is, so the detail scrolls it with everything else; a
// swipe that starts in it stays in it. The page gets the device as its app
// may see it, again as it changes, and an Escape it doesn't use closes the
// detail, as one pressed anywhere else in it does.

export function DeviceFrame(props: {
  app: HostedApp;
  page: string;
  title: string;
  device: DeviceInfo;
  household:
    { temperatureUnit: TemperatureUnit; timeZone: string | null } | undefined;
  isAway: boolean;
  onEscape: () => void;
}) {
  const { app, household } = props;
  const { name } = app.info;
  const [height, setHeight] = useState<number>();
  const context = useMemo<FrameContext>(
    () => ({
      mode: "evening",
      temperatureUnit: household?.temperatureUnit ?? null,
      timeZone: household?.timeZone ?? null,
    }),
    [household?.temperatureUnit, household?.timeZone],
  );
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  const shown = useFrame({
    app,
    context,
    isAway: props.isAway,
    setup: () => ({
      page: latest.current.page,
      params: {},
      device: latest.current.device,
    }),
    on(event) {
      if (event.type === "size") setHeight(event.height);
      else if (event.type === "key") latest.current.onEscape();
    },
  });
  const { phase, failed } = shown;

  useEffect(() => {
    shown.send({ type: "device", device: props.device });
    // Only a change of the device itself is news to the page.
  }, [props.device]);

  if (shown.mismatch) {
    return (
      <PageDoesntMatch app={app.info} mismatch={shown.mismatch} isDevicePage />
    );
  }
  return (
    <>
      {failed ? (
        <NoticeCard
          Icon={CircleAlert}
          isWrong
          title={
            phase === "stopped"
              ? `${possessive(name)} ${props.title} stopped working`
              : `${possessive(name)} ${props.title} didn't open`
          }
          line={[
            phase === "late" && "It didn't answer in time.",
            phase === "files" && "Its files didn't load.",
            `What ${name} adds to the home keeps working.`,
          ]
            .filter(Boolean)
            .join(" ")}
          action={
            <Button variant="outline" onClick={shown.tryAgain}>
              Try again
            </Button>
          }
        />
      ) : (
        shown.showsLoader && (
          <div role="status" className="flex items-center gap-3">
            <KnotLoader className="size-7 shrink-0 text-(--secondary)" />
            <p className="m-0 text-muted-foreground">Opening {props.title}</p>
          </div>
        )
      )}
      <iframe
        key={shown.frameKey}
        {...shown.frameProps}
        title={`${name}: ${props.title}`}
        style={{ height: phase === "ready" ? height : 0 }}
        className={cn(
          "w-full border-0 bg-transparent",
          (failed || phase !== "ready") && "invisible",
        )}
      />
    </>
  );
}
