import {
  capabilityOf,
  permissionIds,
  registerPermission,
  type AppDefinition,
  type CapabilityKind,
  type ServiceConnection,
} from "@meetsanctum/app-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDriverCore, type DriverCore } from "./driver-core.js";

// The capability test suite every driver app must pass: it maps its devices
// onto declared capabilities, reports their state in each kind's shape,
// carries out commands and reports them done, hands on each press of a
// button once, and reports errors: a device that stops answering, and a
// command for a device it does not know. A driver's own tests run it with a
// harness that drives its protocol, such as a broker and a pretend bridge.

export type DriverHarness = {
  app: AppDefinition;
  /** The capability kinds the driver brings. */
  kinds: readonly CapabilityKind[];
  /**
   * After the driver has started, makes one device of this kind appear to
   * it, the way pairing would, or as someone adds one it found through the
   * suite's core. Resolves to the driver's key for it.
   */
  add(kind: CapabilityKind, core: DriverCore): Promise<string>;
  /** Makes the device stop answering, as if it was unplugged. */
  unplug(key: string): Promise<void>;
  /** Presses one of a button's actions on the device, for drivers that bring buttons. */
  press?(key: string, action: string): Promise<void>;
  /** The services the driver asks for, such as its broker account. */
  services?: Record<string, ServiceConnection>;
  /** The app's migrations, for a driver with its own database. */
  migrationsFolder?: string;
  /** Sets up and tears down the protocol side around each test. */
  setUp?(): Promise<void>;
  tearDown?(): Promise<void>;
  /** How long a device may take to report, in ms. */
  timeoutMs?: number;
};

/**
 * Commands as the core hands them to a driver, one after the other, for a
 * capability with these features.
 */
export function sampleCommands(
  kind: CapabilityKind,
  features: unknown,
): Record<string, unknown>[] {
  // A button, a sensor and a contact sensor take no commands; a motion
  // sensor's change its settings.
  if (kind === "button" || kind === "sensor" || kind === "contact") {
    return [];
  }
  if (kind === "switch") {
    return [{ on: true }, { on: false }];
  }
  if (kind === "media") {
    // Each thing it can do, and back again where that has a way back.
    const media = capabilityOf("media").features.parse(features) as {
      power: boolean;
      playback: string[];
      volume: "level" | "steps" | null;
      mute: boolean;
    };
    const can = (word: string) => media.playback.includes(word);
    return [
      ...(media.power ? [{ on: false }, { on: true }] : []),
      ...(can("play") ? [{ activity: "playing" }] : []),
      ...(can("pause") ? [{ activity: "paused" }] : []),
      ...(["next", "previous", "stop"] as const)
        .filter(can)
        .map((playback) => ({ playback })),
      ...(can("seek") ? [{ position: 0 }] : []),
      ...(media.volume === "level" ? [{ volume: 40 }, { volume: 20 }] : []),
      ...(media.volume !== null
        ? [{ volumeStep: "up" }, { volumeStep: "down" }]
        : []),
      ...(media.mute ? [{ muted: true }, { muted: false }] : []),
    ];
  }
  if (kind === "motion") {
    // Each setting it has, changed and back again.
    const motion = capabilityOf("motion").features.parse(features) as {
      sensitivity: string[] | null;
      clearAfter: { min: number; max: number } | null;
      indicator: boolean;
    };
    return [
      ...(motion.sensitivity
        ? [
            { sensitivity: motion.sensitivity.at(-1) },
            { sensitivity: motion.sensitivity[0] },
          ]
        : []),
      ...(motion.clearAfter
        ? [
            { clearAfter: motion.clearAfter.max },
            { clearAfter: motion.clearAfter.min },
          ]
        : []),
      ...(motion.indicator ? [{ indicator: false }, { indicator: true }] : []),
    ];
  }
  const light = capabilityOf("light").features.parse(features) as {
    brightness: boolean;
    colorTemperature: { min: number; max: number } | null;
    color: boolean;
  };
  const range = light.colorTemperature;
  return [
    { on: true },
    ...(light.brightness ? [{ on: true, brightness: 40 }] : []),
    ...(range
      ? [
          {
            on: true,
            colorTemperature: Math.round((range.min + range.max) / 2),
          },
        ]
      : []),
    ...(light.color ? [{ on: true, hue: 120, saturation: 80 }] : []),
    { on: false },
  ];
}

// Every field the command asked for, as the device reported it.
function confirms(
  state: Record<string, unknown> | undefined,
  desired: Record<string, unknown>,
) {
  return (
    !!state &&
    Object.entries(desired).every(([field, value]) => state[field] === value)
  );
}

export function describeDriver(harness: DriverHarness) {
  const { app } = harness;
  const timeoutMs = harness.timeoutMs ?? 2_000;

  describe(`${app.id} meets the capability contract`, () => {
    let core: DriverCore;

    beforeEach(async () => {
      await harness.setUp?.();
      core = createDriverCore(app, {
        services: harness.services,
        migrationsFolder: harness.migrationsFolder,
      });
      await core.start();
    });

    afterEach(async () => {
      try {
        try {
          await core.stop();
        } finally {
          core.close();
        }
      } finally {
        await harness.tearDown?.();
      }
      // Even when it does not wait for the answer, a driver never sends
      // the core something it refuses.
      expect(core.refused).toEqual([]);
    });

    it("holds devices.register and takes its devices' commands", () => {
      expect(permissionIds(app.permissions)).toContain(registerPermission);
      expect(typeof app.driver?.command).toBe("function");
    });

    for (const kind of harness.kinds) {
      describe(`a ${kind}`, () => {
        // Adds one and waits for the driver to register it.
        async function bring() {
          const key = await harness.add(kind, core);
          const capabilityOfKind = () =>
            core.registered
              .get(key)
              ?.capabilities.find((each) => each.kind === kind);
          await core.until(
            () => !!capabilityOfKind(),
            `${key} registered with a ${kind}`,
            timeoutMs,
          );
          return { key, capability: capabilityOfKind()! };
        }

        it("is registered with the kind's features", async () => {
          const { capability } = await bring();
          expect(
            capabilityOf(kind).features.safeParse(capability.features).success,
          ).toBe(true);
        });

        if (kind === "button") {
          it("has each press handed on once, as it happens", async () => {
            const { key, capability } = await bring();
            if (!harness.press) {
              throw new Error("The harness cannot press a button");
            }
            const actions = capabilityOf("button").features.parse(
              capability.features,
            ) as { actions: string[] };
            for (const action of actions.actions.slice(0, 2)) {
              const from = core.presses.length;
              await harness.press(key, action);
              await core.until(
                () => core.presses.length > from,
                `${key} pressed ${action}`,
                timeoutMs,
              );
              expect(core.presses.slice(from)).toEqual([
                { key, capability: capability.id, action },
              ]);
            }
          });
        } else {
          it("has its state reported in the kind's shape", async () => {
            const { key, capability } = await bring();
            // The suite's core checks each report's shape as it arrives.
            await core.until(
              () => !!core.latest(key, capability.id),
              `${key} reported its ${kind} state`,
              timeoutMs,
            );
          });

          it("carries out commands and reports done those that ask for state", async () => {
            const { key, capability } = await bring();
            for (const command of sampleCommands(kind, capability.features)) {
              const from = core.reports.length;
              await core.command(key, capability.id, kind, command);
              const desired = capabilityOf(kind).desired(command) as Record<
                string,
                unknown
              >;
              // A command that asks for no state, such as a media player's
              // next track, is done once the driver takes it.
              if (Object.keys(desired).length === 0) continue;
              await core.until(
                () =>
                  core.reports
                    .slice(from)
                    .some(
                      (report) =>
                        report.key === key &&
                        confirms(report.states[capability.id], desired),
                    ),
                `${key} confirmed ${JSON.stringify(command)}`,
                timeoutMs,
              );
            }
          });
        }

        it("is reported offline once it stops answering", async () => {
          const { key } = await bring();
          await harness.unplug(key);
          await core.until(
            () =>
              core.reports.some(
                (report) =>
                  report.key === key && report.availability === "offline",
              ),
            `${key} reported offline`,
            timeoutMs,
          );
        });
      });
    }

    it("refuses a command for a device it does not know", async () => {
      const kind = harness.kinds[0]!;
      const [command] = sampleCommands(kind, {});
      await expect(
        core.command("not-a-device", kind, kind, command!),
      ).rejects.toMatchObject({ name: "ActionError", code: "not_found" });
    });
  });
}
