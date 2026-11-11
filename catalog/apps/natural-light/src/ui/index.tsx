import { PageBar, defineAppUi, type PageProps } from "@meetsanctum/ui-sdk";

import { CurveCard } from "./curve-card";
import { LightList } from "./light-list";
import { useNaturalLight } from "./use-natural-light";
import { version } from "../../sanctum-app.json";

// Natural light's UI, which the shell bundles: its main page with today's
// curve and the lights that follow it. The curve's settings are its
// preferences, which the shell's settings button at the end of the top bar
// opens. Lights are household things, so it is the same on every device.

const grid =
  "grid auto-rows-(--cell) grid-cols-[repeat(auto-fill,var(--cell))] gap-(--cell-gap)";

function MainPage(_props: PageProps) {
  const view = useNaturalLight();
  return (
    <>
      <PageBar title="Natural light" />
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
