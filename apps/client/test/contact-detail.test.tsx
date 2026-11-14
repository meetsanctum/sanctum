import { quietAfterMs, type DeviceInfo } from "@meetsanctum/app-sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ContactPage } from "../src/contact-detail";
import { tilesOf } from "../src/device-tiles";
import { contactSensor, places } from "./place-pages-fixtures";

const now = new Date(2026, 9, 31, 15).getTime();

function shown(device: DeviceInfo, at = now) {
  const capability = device.capabilities.find(
    (each) => each.kind === "contact",
  )!;
  return renderToStaticMarkup(
    <ContactPage device={device} capability={capability} now={at} />,
  );
}

describe("a contact sensor's detail", () => {
  it.each([true, false])(
    "stops showing an old reading when its battery goes quiet (open: %s)",
    (open) => {
      const device: DeviceInfo = {
        ...contactSensor("door", "Door", "hall", open),
        availability: "unknown",
        lastSeenAt: new Date(now - quietAfterMs).toISOString(),
      };
      expect(shown(device, now - 1)).toContain(open ? "Open" : "Closed");
      expect(shown(device)).toContain("Not heard from");
      expect(shown(device)).not.toContain(open ? "Open" : "Closed");
      expect(
        shown({ ...device, lastSeenAt: new Date(now).toISOString() }),
      ).toContain(open ? "Open" : "Closed");
    },
  );

  it.each([null, new Date(now - 60_000).toISOString()])(
    "says the same as its tile when offline (left at: %s)",
    (leftAt) => {
      const device: DeviceInfo = {
        ...contactSensor("door", "Door", "hall", false),
        availability: "offline",
        leftAt,
      };
      const tile = tilesOf([device], places, new Map(), now)[0]!;
      expect(shown(device)).toContain(tile.status);
    },
  );
});
