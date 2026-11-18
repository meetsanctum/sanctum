import { describe, expect, it } from "vitest";

import { kindOf } from "../src/activity/kinds.js";

describe("activity kinds", () => {
  it("keeps adding, removing and deleting an app in setup, Sanctum's deadline too", () => {
    for (const action of ["app.add", "app.remove", "app.delete"]) {
      expect(kindOf({ source: "sanctum.example", action })).toBe("setup");
    }
    expect(
      kindOf({
        source: "sanctum.example",
        action: "app.delete",
        actor: "sanctum",
      }),
    ).toBe("setup");
  });

  it("puts an app's own action a workflow ran in automations, whatever its name", () => {
    expect(
      kindOf({
        source: "sanctum.example",
        action: "app.refresh",
        actor: "workflow",
      }),
    ).toBe("automations");
  });
});
