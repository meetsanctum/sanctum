// People: who lives in the home, which the core keeps for every app. Apps
// read them with ctx.people.list() under `people.read`: the names, avatars
// and colours every client of the home shows them by, shared ones too.

export const peopleReadPermission = "people.read";

export type PersonInfo = {
  id: string;
  name: string;
  /** One of the avatars the apps ship, by its key, or none. */
  avatar: string | null;
  /** Their identity colour, such as #8fb5c9. */
  colour: string;
};
