import { describe, expect, it } from "vitest";

import { callBodySchema } from "../src/protocol.js";

describe("lifecycle calls", () => {
  it.each([undefined, ""])(
    "refuses an update without its previous version (%s)",
    (from) => {
      expect(
        callBodySchema.safeParse({ kind: "start", reason: "updated", from })
          .success,
      ).toBe(false);
    },
  );

  it("accepts an update with its previous version", () => {
    expect(
      callBodySchema.parse({ kind: "start", reason: "updated", from: "1.0.0" }),
    ).toEqual({ kind: "start", reason: "updated", from: "1.0.0" });
  });
});
