import { describe, expect, it } from "vitest";

import { lanInterfaces, txtRecord } from "../src/announce.js";

describe("host announcement", () => {
  it("carries the host id and whether it is claimed", () => {
    expect(
      txtRecord({ name: "Sanctum", hostId: "b0x", claimed: false, port: 4100 }),
    ).toEqual({ id: "b0x", claimed: "0" });
    expect(
      txtRecord({ name: "Sanctum", hostId: "b0x", claimed: true, port: 4100 }),
    ).toEqual({ id: "b0x", claimed: "1" });
  });

  it("carries the home's id once the core has reported it", () => {
    expect(
      txtRecord({
        name: "Sanctum",
        hostId: "b0x",
        homeId: "h0me",
        claimed: true,
        port: 4100,
      }),
    ).toEqual({ id: "b0x", home: "h0me", claimed: "1" });
  });

  it("leaves loopback and Docker's bridges out", () => {
    for (const name of lanInterfaces()) {
      expect(name).not.toMatch(/^(lo|docker|br-|veth)/);
    }
  });
});
