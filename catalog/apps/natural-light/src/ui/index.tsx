import {
  Button,
  Card,
  PageBar,
  defineAppUi,
  type PageProps,
} from "@meetsanctum/ui-sdk";

import { CurveCard } from "./curve-card";
import { LightList } from "./light-list";
import { useNaturalLight } from "./use-natural-light";
import { version } from "../../sanctum-app.json";

// Natural light's UI, which the shell bundles: its main page with today's
// curve and the lights, by room, that follow it. Whether it is on and the
// curve are its preferences, which the shell's settings button at the end of
// the top bar opens; while it is off, the page says so first, with a link
// there. Lights are household things, so it is the same on every device.

const grid =
  "grid auto-rows-(--cell) grid-cols-[repeat(auto-fill,var(--cell))] gap-(--cell-gap)";

function MainPage(props: PageProps) {
  const view = useNaturalLight();
  return (
    <>
      <PageBar title="Natural light" />
      {view.loaded && !view.isOn && (
        <Card className="max-w-md shrink-0">
          <div className="flex flex-col gap-1 px-2.5 py-2">
            <p className="m-0 text-sm font-medium">Natural light is off</p>
            <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
              Lights keep the look they have and don’t change with the day.
            </p>
            <div>
              <Button
                variant="link"
                size="label"
                onClick={() => props.openSettings()}
              >
                Open settings
              </Button>
            </div>
          </div>
        </Card>
      )}
      <div className={`shrink-0 ${grid}`}>
        <CurveCard preview={view.preview} />
      </div>
      <LightList view={view} />
    </>
  );
}

export default defineAppUi({
  id: "sanctum.natural-light",
  version,
  pages: { main: MainPage },
});
