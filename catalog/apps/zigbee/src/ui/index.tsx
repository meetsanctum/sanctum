import { defineAppUi, PageBar, type PageProps } from "@meetsanctum/ui-sdk";
import { version } from "../../sanctum-app.json";

// Zigbee's UI, which the shell bundles. Its main page, which the app
// overview opens, says where devices are added and removed: in Settings,
// since that is the core's.

function MainPage(_props: PageProps) {
  return (
    <>
      <PageBar title="Zigbee" />
      <p className="m-0 text-[15px] leading-[22px] text-muted-foreground">
        Add and remove Zigbee devices in Settings.
      </p>
    </>
  );
}

export default defineAppUi({
  id: "sanctum.zigbee",
  version,
  pages: { main: MainPage },
});
