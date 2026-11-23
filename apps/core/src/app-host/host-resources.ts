import type { HostResources } from "@meetsanctum/app-sdk";

import type { HostStatus } from "../manager-answers.js";

// What an app reads of the host (ctx.host.resources): what Settings → Status
// shows of its processor, memory and storage, and nothing that names the
// home or its network.

export function hostResourcesOf(status: HostStatus): HostResources {
  return {
    processor: {
      // A Raspberry Pi names its board; x86 names its processor.
      name: status.model ?? status.processor.name ?? null,
      cores: status.processor.cores,
      matrixInstructions: status.processor.matrixInstructions ?? null,
    },
    memory: status.memory && {
      totalBytes: status.memory.total,
      availableBytes: status.memory.available,
    },
    storage: status.storage && { freeBytes: status.storage.free },
  };
}
