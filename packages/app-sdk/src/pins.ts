// The household's pinned apps: the apps at the top of the sidebar, in the
// household's order, which the core keeps like the dashboards, so every
// client shows the same ones, shared tablets included. Sanctum's own apps,
// such as `sanctum.settings`, may be pinned too. They are the shell's: apps
// never read them, and their live updates do not reach apps' pages.

// Their routes, for every client, shared ones included.
// `GET /api/pins` answers the pinned apps' ids (`string[]`) in their order.

/**
 * `POST /api/pins/update`: the whole list in its new order, each app once,
 * so pinning, unpinning and reordering are each one update. It answers the
 * list as stored (`string[]`).
 */
export type UpdatePins = { apps: string[] };
