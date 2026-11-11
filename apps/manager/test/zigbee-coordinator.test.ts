import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  chooseZigbeeCoordinator,
  scanZigbeeCoordinators,
} from "../src/services/zigbee-coordinator.js";
import {
  createZigbeeCoordinatorCandidate,
  zigbeeCoordinatorSerialDefaults,
} from "../src/services/zigbee-coordinator-profiles.js";
import { conbee, hostDev, zbt2 } from "./host-dev.js";

describe("Zigbee coordinator detection", () => {
  it("finds a ZBT-2 by its by-id path, not its tty", async () => {
    const dev = await hostDev();
    await dev.plug(zbt2, "ttyACM0");

    expect(await scanZigbeeCoordinators(dev.root)).toEqual([
      {
        path: zbt2,
        resolvedPath: "/dev/ttyACM0",
        label: "Nabu Casa ZBT-2",
        adapter: "ember",
        matchConfidence: "exact",
        profileId: "nabu-casa-zbt-2",
        recommended: true,
      },
    ]);
  });

  it("lists ttys without a by-id link, and never the Pi's own UART", async () => {
    const dev = await hostDev();
    await writeFile(join(dev.root, "ttyUSB0"), "");

    expect(await scanZigbeeCoordinators(dev.root)).toEqual([
      expect.objectContaining({
        path: "/dev/ttyUSB0",
        adapter: null,
        profileId: null,
        recommended: false,
      }),
    ]);
  });

  it("finds nothing when nothing is plugged in", async () => {
    const dev = await hostDev();
    expect(await scanZigbeeCoordinators(dev.root)).toEqual([]);
  });

  it("ignores broken by-id links and links outside the host's devices", async () => {
    const dev = await hostDev();
    await dev.plug(zbt2, "ttyACM0");
    await rm(join(dev.root, "ttyACM0"));
    await symlink(
      "/etc/passwd",
      join(dev.root, "serial", "by-id", "usb-outside"),
    );

    expect(await scanZigbeeCoordinators(dev.root)).toEqual([]);
  });

  it("says so when it cannot see the host's devices", async () => {
    await expect(scanZigbeeCoordinators("/no/such/dev")).rejects.toThrow(
      /cannot see the host's devices/,
    );
  });
});

describe("Zigbee coordinator profiles", () => {
  it("configures a ZBT-2 with Ember serial settings", () => {
    expect(
      zigbeeCoordinatorSerialDefaults(zbt2, undefined, "nabu-casa-zbt-2"),
    ).toEqual({ adapter: "ember", baudRate: 460_800, rtscts: true });
  });

  it("infers deconz for a ConBee and keeps herdsman's serial defaults", () => {
    expect(zigbeeCoordinatorSerialDefaults(conbee)).toEqual({
      adapter: "deconz",
    });
  });

  it("uses the ConBee III's baud rate without changing the ConBee II", () => {
    const candidate = createZigbeeCoordinatorCandidate(
      conbee.replace("ConBee_II_", "ConBee_III_"),
      "/dev/ttyUSB0",
    );
    expect(chooseZigbeeCoordinator(undefined, [candidate])).toMatchObject({
      coordinator: { serial: { adapter: "deconz", baudRate: 115_200 } },
    });
    expect(zigbeeCoordinatorSerialDefaults(conbee)).toEqual({
      adapter: "deconz",
    });
  });

  it("honours an explicit adapter override instead of a guessed profile", () => {
    expect(
      zigbeeCoordinatorSerialDefaults(zbt2, "zstack", "nabu-casa-zbt-2"),
    ).toEqual({ adapter: "zstack" });
  });

  it("does not take a SkyConnect for a ZBT-2", () => {
    const skyConnect = createZigbeeCoordinatorCandidate(
      "/dev/serial/by-id/usb-Nabu_Casa_SkyConnect_v1.0_3abe5479-if00-port0",
      "/dev/ttyUSB0",
    );
    expect(skyConnect).toMatchObject({
      adapter: "ember",
      profileId: null,
      recommended: false,
    });
    expect(
      zigbeeCoordinatorSerialDefaults(skyConnect.path, undefined, null),
    ).toEqual({ adapter: "ember" });
  });
});

describe("choosing the Zigbee coordinator", () => {
  const candidate = (path: string) =>
    createZigbeeCoordinatorCandidate(path, "/dev/ttyACM0");

  it("waits while none is plugged in", () => {
    expect(chooseZigbeeCoordinator(undefined, [])).toEqual({
      problem: "No Zigbee coordinator is plugged in",
    });
  });

  it("picks the only one plugged in", () => {
    expect(chooseZigbeeCoordinator(undefined, [candidate(zbt2)])).toEqual({
      coordinator: {
        path: zbt2,
        adapter: "ember",
        profileId: "nabu-casa-zbt-2",
        serial: { adapter: "ember", baudRate: 460_800, rtscts: true },
      },
      picked: { path: zbt2, adapter: "ember", profileId: "nabu-casa-zbt-2" },
    });
  });

  it("asks which one when several are plugged in", () => {
    const result = chooseZigbeeCoordinator(undefined, [
      candidate(zbt2),
      candidate(conbee),
    ]);
    expect(result).toEqual({ problem: expect.stringMatching(/choose one/) });
  });

  it("keeps the chosen one, and waits for it rather than switching", () => {
    const chosen = { path: conbee, adapter: "deconz" as const };
    expect(
      chooseZigbeeCoordinator(chosen, [candidate(zbt2), candidate(conbee)]),
    ).toEqual({
      coordinator: { ...chosen, serial: { adapter: "deconz" } },
    });
    expect(chooseZigbeeCoordinator(chosen, [candidate(zbt2)])).toEqual({
      problem: `The Zigbee coordinator ${conbee} is not plugged in`,
    });
  });

  it("asks for the adapter type when the path does not tell", () => {
    expect(
      chooseZigbeeCoordinator(undefined, [candidate("/dev/ttyUSB0")]),
    ).toEqual({
      problem: "Choose the adapter type of the Zigbee coordinator /dev/ttyUSB0",
    });
    expect(
      chooseZigbeeCoordinator({ path: "/dev/ttyUSB0", adapter: "zstack" }, [
        candidate("/dev/ttyUSB0"),
      ]),
    ).toMatchObject({ coordinator: { serial: { adapter: "zstack" } } });
  });
});
