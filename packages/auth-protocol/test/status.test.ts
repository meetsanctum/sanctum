import { describe, expect, it } from "vitest";

import { readHostStatus } from "../src/index.js";

describe("a host's status", () => {
  const hostId = "6b0f6f4e-2a52-4f8e-9a51-1d1d1f6e6e73";
  const homeId = "0d5c1f0a-7a43-4b6e-8f0e-2f6a0c9b1e55";

  it("holds the host id, the home id and the claimed flag", () => {
    expect(readHostStatus({ hostId, homeId, claimed: true })).toEqual({
      hostId,
      homeId,
      claimed: true,
    });
  });

  it.each([
    null,
    "status",
    {},
    { hostId, homeId },
    // From before home ids, and before the code said host.
    { hostId, claimed: true },
    { boxId: hostId, homeId, claimed: true },
    { hostId: "", homeId, claimed: true },
    { hostId: 7, homeId, claimed: true },
    { hostId, homeId: 7, claimed: true },
    { hostId, homeId, claimed: "true" },
  ])("is not read from %j", (body) => {
    expect(readHostStatus(body)).toBeNull();
  });
});
