import type { Places } from "@meetsanctum/app-sdk";
import { Button, icons } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

import { noRoomName } from "./device-tiles";
import { getShell } from "./shell";
import { SidebarHeading, SidebarItem } from "./sidebar-item";

// The sidebar's rooms, under its Rooms heading. Once the home has floors,
// each floor is a row in its order, with the layers mark, its name and a
// chevron that is always there, and its rooms indented under it, as folders
// are in Finder; the rooms on no floor follow at the outer level, then No
// room. A floor's row only folds its rooms away and back, and a folded one
// says how many it holds; one folded over the page on show is drawn as the
// current place is, since nothing should unfold by itself. Each device keeps
// what it folded, as it keeps the sidebar collapsed or not. The rows open
// pages and fold; none switches a light.

const preferenceKey = "sidebar.foldedFloors";

function useFolded() {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let isStopped = false;
    getShell()
      .preferences.get(preferenceKey)
      .then(
        (kept) => {
          if (isStopped || !kept) return;
          try {
            const ids: unknown = JSON.parse(kept);
            if (Array.isArray(ids)) {
              setFolded(
                new Set(
                  ids.filter((id): id is string => typeof id === "string"),
                ),
              );
            }
          } catch {
            // Kept by another version, or broken: everything shows.
          }
        },
        () => undefined,
      );
    return () => {
      isStopped = true;
    };
  }, []);
  const toggle = (id: string) =>
    setFolded((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // Where it cannot be kept, it is remembered until the app restarts.
      getShell()
        .preferences.set(preferenceKey, JSON.stringify([...next]))
        .catch(() => undefined);
      return next;
    });
  return { folded, toggle };
}

export function SidebarRooms(props: {
  places: Places | undefined;
  /** The room whose page is on show, if one is. */
  currentRoom: string | null;
  hasNoRoom: boolean;
  isNoRoomCurrent: boolean;
  openRoom: (id: string) => void;
  openNoRoom: () => void;
}) {
  const { folded, toggle } = useFolded();
  const rooms = props.places?.rooms ?? [];
  const floors = props.places?.floors ?? [];
  if (rooms.length === 0 && !props.hasNoRoom) return null;
  const known = new Set(floors.map((floor) => floor.id));
  const roomItem = (room: { id: string; name: string }) => (
    <SidebarItem
      key={room.id}
      icon={icons.DoorOpen}
      name={room.name}
      current={props.currentRoom === room.id}
      onSelect={() => props.openRoom(room.id)}
    />
  );
  return (
    <>
      <SidebarHeading>Rooms</SidebarHeading>
      {floors.map((floor) => {
        const onIt = rooms.filter((room) => room.floorId === floor.id);
        const isFolded = folded.has(floor.id);
        const holdsCurrent = onIt.some((room) => room.id === props.currentRoom);
        const Chevron = isFolded ? icons.ChevronRight : icons.ChevronDown;
        return (
          <div key={floor.id} className="flex flex-col gap-0.5">
            <Button
              variant="ghost"
              size="item"
              aria-expanded={!isFolded}
              aria-current={isFolded && holdsCurrent ? "page" : undefined}
              onClick={() => toggle(floor.id)}
              className="group"
            >
              <span className="grid size-6 shrink-0 place-items-center text-foreground/85 group-aria-[current=page]:text-background">
                <icons.Layers aria-hidden="true" className="size-4.5" />
              </span>
              <span className="min-w-0 flex-1 truncate">{floor.name}</span>
              {isFolded && onIt.length > 0 && (
                <span className="shrink-0 text-[13px] font-normal text-foreground/65 group-aria-[current=page]:text-background/65">
                  {onIt.length}
                </span>
              )}
              <Chevron
                aria-hidden="true"
                className="size-3.5 shrink-0 text-foreground/65 group-aria-[current=page]:text-background/65"
              />
            </Button>
            {!isFolded && onIt.length > 0 && (
              <div
                role="group"
                aria-label={floor.name}
                className="flex flex-col gap-0.5 ps-6"
              >
                {onIt.map(roomItem)}
              </div>
            )}
          </div>
        );
      })}
      {rooms
        .filter((room) => room.floorId === null || !known.has(room.floorId))
        .map(roomItem)}
      {props.hasNoRoom && (
        <SidebarItem
          icon={icons.SquareDashed}
          name={noRoomName}
          current={props.isNoRoomCurrent}
          onSelect={props.openNoRoom}
        />
      )}
    </>
  );
}
