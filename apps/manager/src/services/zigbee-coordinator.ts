import { readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  createZigbeeCoordinatorCandidate,
  zigbeeCoordinatorSerialDefaults,
  type ZigbeeAdapter,
  type ZigbeeCoordinatorCandidate,
  type ZigbeeSerialSettings,
} from "./zigbee-coordinator-profiles.js";

// Ported from v1's docker-zigbee-coordinator: finds the USB serial devices
// that may be a Zigbee coordinator and picks the one Zigbee2MQTT uses. The
// manager sees the host's /dev read-only at `hostDevDir`
// (deploy/compose.yml); the paths it returns are the host's, as Docker needs
// them. macOS paths and the serial proxy are gone: development runs on a Pi.

// The coordinator Zigbee2MQTT uses, as chosen by a person or picked when it
// was the only one plugged in.
export type ZigbeeCoordinatorChoice = {
  path: string;
  adapter?: ZigbeeAdapter;
  profileId?: string;
};

export type ZigbeeCoordinator = ZigbeeCoordinatorChoice & {
  serial: ZigbeeSerialSettings & { adapter: ZigbeeAdapter };
};

async function list(directory: string) {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function scanZigbeeCoordinators(
  hostDevDir: string,
): Promise<ZigbeeCoordinatorCandidate[]> {
  const root = await realpath(hostDevDir).catch(() => {
    throw new Error(
      `The manager cannot see the host's devices: ${hostDevDir} is missing (deploy/compose.yml mounts /dev there)`,
    );
  });
  const toHost = (path: string) => {
    const inside = relative(root, path);
    return inside.startsWith("..") ? null : join("/dev", inside);
  };
  const resolve = (path: string) => realpath(path).then(toHost, () => null);

  const candidates: ZigbeeCoordinatorCandidate[] = [];
  const byId = join(hostDevDir, "serial", "by-id");
  for (const entry of await list(byId)) {
    const resolvedPath = await resolve(join(byId, entry));
    // udev can leave a link visible briefly after its device disappears.
    // Only devices present under the host's /dev may be selected.
    if (!resolvedPath) continue;
    candidates.push(
      createZigbeeCoordinatorCandidate(
        `/dev/serial/by-id/${entry}`,
        resolvedPath,
      ),
    );
  }
  // The Pi's own UARTs (ttyAMA, ttyS) are never a USB coordinator.
  for (const entry of await readdir(root)) {
    if (/^tty(USB|ACM)\d+$/.test(entry)) {
      const path = `/dev/${entry}`;
      candidates.push(createZigbeeCoordinatorCandidate(path, path));
    }
  }

  const byDevice = new Map<string, ZigbeeCoordinatorCandidate>();
  for (const candidate of candidates) {
    const key = candidate.resolvedPath ?? candidate.path;
    const existing = byDevice.get(key);
    if (!existing || preferZigbeeCoordinatorCandidate(candidate, existing)) {
      byDevice.set(key, candidate);
    }
  }
  return [...byDevice.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function preferZigbeeCoordinatorCandidate(
  candidate: ZigbeeCoordinatorCandidate,
  existing: ZigbeeCoordinatorCandidate,
) {
  if (
    candidate.path.startsWith("/dev/serial/by-id/") !==
    existing.path.startsWith("/dev/serial/by-id/")
  ) {
    return candidate.path.startsWith("/dev/serial/by-id/");
  }
  if (candidate.recommended !== existing.recommended) {
    return candidate.recommended;
  }
  return candidate.path.length > existing.path.length;
}

// The chosen coordinator, or the only one plugged in when none was chosen
// (`picked`, for the caller to keep). Never switches to another coordinator
// on its own: a new one would start a new Zigbee network.
export function chooseZigbeeCoordinator(
  chosen: ZigbeeCoordinatorChoice | undefined,
  candidates: ZigbeeCoordinatorCandidate[],
):
  | { coordinator: ZigbeeCoordinator; picked?: ZigbeeCoordinatorChoice }
  | { problem: string } {
  let choice = chosen;
  let picked: ZigbeeCoordinatorChoice | undefined;
  if (choice) {
    if (!candidates.some((candidate) => candidate.path === choice!.path)) {
      return {
        problem: `The Zigbee coordinator ${choice.path} is not plugged in`,
      };
    }
  } else {
    if (candidates.length === 0) {
      return { problem: "No Zigbee coordinator is plugged in" };
    }
    if (candidates.length > 1) {
      return {
        problem: `Several possible Zigbee coordinators are plugged in (${candidates
          .map((candidate) => candidate.path)
          .join(", ")}): choose one`,
      };
    }
    const only = candidates[0]!;
    picked = choice = {
      path: only.path,
      ...(only.adapter ? { adapter: only.adapter } : {}),
      ...(only.profileId ? { profileId: only.profileId } : {}),
    };
  }

  const serial = zigbeeCoordinatorSerialDefaults(
    choice.path,
    choice.adapter,
    choice.profileId,
  );
  if (!serial.adapter) {
    return {
      problem: `Choose the adapter type of the Zigbee coordinator ${choice.path}`,
    };
  }
  return {
    coordinator: { ...choice, serial: { ...serial, adapter: serial.adapter } },
    ...(picked ? { picked } : {}),
  };
}
