import type { FloorRemoval } from "@meetsanctum/app-sdk";

import type { Workflows } from "../workflows/workflows.js";
import { PlacesError, type PlacesModule } from "./places.js";

// What removing a floor takes with it, for the warning someone reads before
// removing it; nothing changes here. Its rooms stay, on no floor, with their
// devices. Workflows keep their config, so those that name the floor, in a
// field their pieces declare with names("floor"), are broken once it is
// gone, until they are changed; a remote's presses an app keeps as
// workflows are among them, and the app puts them back as it chooses.

export function floorRemoval(
  modules: {
    places: Pick<PlacesModule, "list">;
    workflows: Pick<Workflows, "naming">;
  },
  floorId: string,
): FloorRemoval {
  const places = modules.places.list();
  if (!places.floors.some((floor) => floor.id === floorId)) {
    throw new PlacesError("not_found", `No floor ${floorId}`);
  }
  const rooms = places.rooms
    .filter((room) => room.floorId === floorId)
    .map(({ id, name }) => ({ id, name }));
  return { rooms, workflows: modules.workflows.naming("floor", floorId) };
}
