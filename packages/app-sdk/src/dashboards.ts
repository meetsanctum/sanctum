// The home's dashboards: the first screen, which the core keeps for the
// household rather than for a person or a device, so every client shows the
// same ones and a replaced tablet finds them as they were. A client
// remembers only which one it shows. They are the shell's: apps never read
// them, and their live updates do not reach apps' pages.

/**
 * The backgrounds a dashboard may have, by name, which the shell draws.
 * Mocha, a warm greige to espresso gradient, is the only one; it replaced
 * burgundy (2026-10-31).
 */
export const dashboardBackgrounds = ["mocha"] as const;
export type DashboardBackground = (typeof dashboardBackgrounds)[number];

/**
 * What a dashboard is. Home is the home's own: every home has it, first
 * among them, and it cannot be removed. It shows each room with what the
 * household put on it. The others are the household's own, and show what
 * Home shows.
 */
export const dashboardKinds = ["home", "custom"] as const;
export type DashboardKind = (typeof dashboardKinds)[number];

export type DashboardInfo = {
  id: string;
  name: string;
  background: DashboardBackground;
} & (
  | {
      kind: "home";
      /**
       * The devices on Home, by id, in the household's order, which Home
       * keeps within each room. A light is on it from when it joins the
       * home; anything else once someone adds it.
       */
      devices: string[];
    }
  | { kind: "custom" }
);

// Their routes, for every client, shared ones included.
// `GET /api/dashboards` answers DashboardInfo[] in their order, Home first.

/** `POST /api/dashboards/add`: a new dashboard after the others, mocha unless it says. */
export type AddDashboard = { name: string; background?: DashboardBackground };
/** `POST /api/dashboards/update`: renames one. */
export type UpdateDashboard = { id: string; name: string };
/** `POST /api/dashboards/remove`: refused with `home_dashboard` for Home. */
export type RemoveDashboard = { id: string };

// What is on Home: each answers Home's DashboardInfo.

/** `POST /api/dashboards/home/add`: a device on Home, last in its room; again changes nothing. */
export type AddToHome = { device: string };
/** `POST /api/dashboards/home/remove`: takes a device off Home; a light stays off. */
export type RemoveFromHome = { device: string };
/**
 * `POST /api/dashboards/home/order`: some of Home's devices, such as a
 * room's, in their new order. They swap the places they had among the
 * others, so the rest stay where they are; each must be on Home.
 */
export type OrderHome = { devices: string[] };
