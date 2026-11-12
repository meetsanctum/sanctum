import type { Places } from "@meetsanctum/app-sdk";
import type { Tile } from "@meetsanctum/ui-sdk";
import { describe, expect, it } from "vitest";

import {
  homeMotion,
  motionText,
  motionWhere,
  placeMotionText,
} from "../src/motion";

// What motion sensors say: words on a tile and in a room's line, and where in
// the home there is motion now.

const minute = 60_000;
// 15:00 where the tests run, so the day and yesterday are local.
const now = new Date(2026, 9, 31, 15, 0).getTime();
const ago = (ms: number) => new Date(now - ms).toISOString();

const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  zones: [],
  rooms: [
    { id: "office", name: "Office", floorId: null },
    { id: "hall", name: "Hall", floorId: null },
    { id: "kitchen", name: "Kitchen", floorId: null },
  ],
};

function sensor(
  roomId: string | null,
  motion: Tile["motion"],
  disabled = false,
): Tile {
  return {
    key: `${roomId}/occupancy`,
    deviceId: String(roomId),
    capabilityId: "occupancy",
    kind: "occupancy",
    roomId,
    name: `${roomId} motion sensor`,
    status: "",
    on: motion?.occupied ?? false,
    look: "off",
    dims: false,
    disabled,
    motion,
  };
}

describe("a motion sensor's words", () => {
  it("say Motion now, or how long it has been quiet", () => {
    expect(motionText(true, ago(5 * minute), now)).toBe("Motion now");
    expect(motionText(false, ago(30_000), now)).toBe("Quiet");
    expect(motionText(false, ago(12 * minute + 30_000), now)).toBe(
      "Quiet for 12 min",
    );
    expect(motionText(false, ago(59 * minute), now)).toBe("Quiet for 59 min");
  });

  it("say since when from an hour, then yesterday, then the date", () => {
    expect(
      motionText(false, new Date(2026, 9, 31, 14, 5).toISOString(), now),
    ).toBe("Quiet for 55 min");
    expect(
      motionText(false, new Date(2026, 9, 31, 13, 5).toISOString(), now),
    ).toBe("Quiet since 13:05");
    expect(
      motionText(false, new Date(2026, 9, 30, 23, 50).toISOString(), now),
    ).toBe("Quiet since yesterday");
    expect(
      motionText(false, new Date(2026, 9, 28, 9, 0).toISOString(), now),
    ).toBe("Quiet since 28 Oct");
  });

  it("say only Quiet when it is not known since when", () => {
    expect(motionText(false, null, now)).toBe("Quiet");
  });
});

describe("a room's motion", () => {
  it("is motion while any of its sensors that answers sees it", () => {
    expect(
      placeMotionText(
        [
          sensor("office", { occupied: false, changedAt: ago(3 * minute) }),
          sensor("office", { occupied: true, changedAt: ago(minute) }),
        ],
        now,
      ),
    ).toBe("Motion now");
  });

  it("is quiet since the last of them went quiet, offline ones left out", () => {
    expect(
      placeMotionText(
        [
          sensor("office", { occupied: false, changedAt: ago(40 * minute) }),
          sensor("office", { occupied: false, changedAt: ago(3 * minute) }),
          sensor("office", { occupied: true, changedAt: ago(minute) }, true),
        ],
        now,
      ),
    ).toBe("Quiet for 3 min");
  });

  it("is Quiet while one of them has not said when it went quiet", () => {
    expect(
      placeMotionText(
        [
          sensor("office", { occupied: false, changedAt: ago(40 * minute) }),
          sensor("office", { occupied: false, changedAt: null }),
        ],
        now,
      ),
    ).toBe("Quiet");
  });

  it("is nothing while none answers", () => {
    expect(placeMotionText([sensor("office", undefined)], now)).toBeNull();
    expect(placeMotionText([], now)).toBeNull();
  });
});

describe("where there is motion in the home", () => {
  const seeing = (roomId: string | null) =>
    sensor(roomId, { occupied: true, changedAt: ago(minute) });
  const quiet = (roomId: string | null) =>
    sensor(roomId, { occupied: false, changedAt: ago(minute) });

  it("names a room or two, in the home's order, and counts more", () => {
    const one = homeMotion([seeing("office"), quiet("hall")], places);
    expect(motionWhere(one)).toBe("Office");
    const two = homeMotion([seeing("hall"), seeing("office")], places);
    expect(motionWhere(two)).toBe("Office and Hall");
    const three = homeMotion(
      [seeing("hall"), seeing("office"), seeing("kitchen")],
      places,
    );
    expect(motionWhere(three)).toBe("3 rooms");
  });

  it("says Quiet, and counts a sensor in no room only while no room has motion", () => {
    const none = homeMotion([quiet("office")], places);
    expect(none.answering).toBe(true);
    expect(motionWhere(none)).toBe("Quiet");
    expect(motionWhere(homeMotion([seeing(null)], places))).toBe("Motion now");
    expect(
      motionWhere(homeMotion([seeing(null), seeing("hall")], places)),
    ).toBe("Hall");
  });

  it("knows when no motion sensor answers", () => {
    const offline = sensor("office", { occupied: true, changedAt: null }, true);
    expect(homeMotion([offline], places)).toEqual({
      answering: false,
      rooms: [],
      elsewhere: false,
    });
  });
});
