import type { OnHome } from "../src/dashboards";

// What is on Home for tests that do not change it: nothing known yet, so
// nothing offers to change it.
export const unknownHome: OnHome = {
  name: "Home",
  devices: undefined,
  add: async () => undefined,
  remove: async () => undefined,
  order: async () => undefined,
};
