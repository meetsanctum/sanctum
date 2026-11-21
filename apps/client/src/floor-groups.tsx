import type { Floor, Places } from "@meetsanctum/app-sdk";
import { icons } from "@meetsanctum/ui-sdk";
import type { ReactNode } from "react";

import { LightsButton, type LightsButtonState } from "./lights-button";

// Rooms under their floors, as Home and the category pages show them once
// the home has floors: each floor in the household's order, then the rooms
// on none under "Other rooms". A floor's heading is one row: the layers
// mark and its name. On Home and Lights' page a floor with lights has its
// button under its name, which turns them off (lights-button.tsx). Wider
// than a phone, the mark hangs at the leading edge, out of the reading
// line, and everything of the floor aligns with its name, as
// the sidebar indents rooms under their floor. The rooms and the Other
// rooms heading share an inset equal to the mark's width plus its gap.
// On a phone, the mark leads the heading's line, and the rooms and the
// Other rooms heading start at the page's edge. A home with no floors
// shows its rooms with no floor headings or indent.

/** What a floor's group holds: the floor, or none for the rooms on no floor. */
export type FloorGroup<T> = { floor: Floor | null; items: T[] };

/** The words over the rooms on no floor, when the home has floors. */
export const otherRoomsName = "Other rooms";

/**
 * Items by the floor of their room, the floors in the household's order,
 * then those on no floor, in no room or in a room the home no longer has;
 * none while the home has no floors. Groups with nothing in them go.
 */
export function byFloor<T>(
  places: Places | undefined,
  items: readonly T[],
  roomOf: (item: T) => string | null,
): FloorGroup<T>[] | null {
  if (!places || places.floors.length === 0) return null;
  const floorOf = new Map(places.rooms.map((room) => [room.id, room.floorId]));
  const known = new Set(places.floors.map((floor) => floor.id));
  const on = (item: T) => {
    const roomId = roomOf(item);
    const floorId = roomId === null ? null : (floorOf.get(roomId) ?? null);
    return floorId !== null && known.has(floorId) ? floorId : null;
  };
  return [
    ...places.floors.map((floor) => ({
      floor,
      items: items.filter((item) => on(item) === floor.id),
    })),
    { floor: null, items: items.filter((item) => on(item) === null) },
  ].filter((group) => group.items.length > 0);
}

/** The rooms on a floor, by id. */
export const roomsOn = (places: Places | undefined, floor: Floor) =>
  new Set(
    (places?.rooms ?? [])
      .filter((room) => room.floorId === floor.id)
      .map((room) => room.id),
  );

export function FloorSection(props: {
  floor: Floor | null;
  /** Its heading's id, unique on the page. */
  id: string;
  lights?: LightsButtonState;
  children: ReactNode;
}) {
  const { floor, lights } = props;
  return (
    <section
      aria-labelledby={props.id}
      className="flex shrink-0 flex-col gap-5"
    >
      <div className="flex flex-col gap-3">
        <div className={`flex items-center gap-2${floor ? "" : " sm:ps-6.5"}`}>
          {floor && (
            <icons.Layers aria-hidden="true" className="size-4.5 shrink-0" />
          )}
          <h2
            id={props.id}
            className="m-0 min-w-0 text-[17px] leading-[22px] font-semibold"
          >
            {floor?.name ?? otherRoomsName}
          </h2>
        </div>
        {lights && (
          <div className="flex sm:ps-6.5">
            <LightsButton lights={lights} />
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-8 sm:ps-6.5">
        {props.children}
      </div>
    </section>
  );
}
