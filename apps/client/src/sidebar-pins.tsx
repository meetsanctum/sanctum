import type { AppIcon as AppIconInfo } from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { LayoutGrid, Pin } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { AppIcon } from "./app-icon";

/** An app pinned at the top of the sidebar, as its tile shows it. */
export type PinnedApp = {
  id: string;
  name: string;
  icon: AppIconInfo;
  current: boolean;
  onOpen: () => void;
};

// The household's pinned apps at the top of the sidebar, as tiles four to a
// row, Apps always last: its grid, which opens every app (apps-page.tsx).
// Fewer than four share the row, so the gap between tiles never changes;
// later rows keep a quarter each. Each tile is the ink at 8% behind the
// app's icon, with the icon's own 9 px corners, and as tall as a quarter of
// the row is wide, so the room around the icon is the same on every side in
// a full row and every tile is that tall however many there are. It is named
// for screen readers and, under the pointer, in its tooltip; the current one
// turns the ink. With nothing pinned, a dashed placeholder with a pin takes
// the room of three, and opens Apps to pin some. Until the household's pins
// are read, Apps alone holds its place in the row, so nothing says none are
// pinned.
export function SidebarPins(props: {
  /** None until the household's pins are read. */
  apps: PinnedApp[] | undefined;
  /** Apps, on show, or the page of an app that isn't pinned. */
  appsCurrent: boolean;
  openApps: () => void;
  pinApps: () => void;
}) {
  const apps = props.apps ?? [];
  const columns = apps.length === 0 ? 4 : Math.min(apps.length + 1, 4);
  return (
    <ul
      aria-label="Pinned apps"
      // A quarter of the row, less the gaps between four tiles.
      style={
        {
          "--columns": columns,
          "--tile-height": "calc((100cqw - 18px) / 4)",
        } as CSSProperties
      }
      className="@container m-0 mb-3 grid shrink-0 list-none grid-cols-[repeat(var(--columns),minmax(0,1fr))] gap-1.5 p-0"
    >
      {apps.map((app) => (
        <li key={app.id} className="min-w-0">
          <PinTile name={app.name} current={app.current} onOpen={app.onOpen}>
            <AppIcon icon={app.icon} className="size-9" />
          </PinTile>
        </li>
      ))}
      {props.apps?.length === 0 && (
        <li className="col-span-3 min-w-0">
          <Button
            variant="placeholder"
            size="tile"
            aria-label="Pin apps"
            title="Pin apps"
            onClick={props.pinApps}
          >
            <Pin aria-hidden="true" className="size-5" />
          </Button>
        </li>
      )}
      <li className={props.apps ? "min-w-0" : "col-start-4 min-w-0"}>
        <PinTile
          name="Apps"
          current={props.appsCurrent}
          onOpen={props.openApps}
        >
          <LayoutGrid aria-hidden="true" className="size-5.5" />
        </PinTile>
      </li>
    </ul>
  );
}

function PinTile(props: {
  name: string;
  current: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="tile"
      size="tile"
      aria-label={props.name}
      title={props.name}
      aria-current={props.current ? "page" : undefined}
      onClick={props.onOpen}
    >
      {props.children}
    </Button>
  );
}
