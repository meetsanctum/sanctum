import {
  socketGroupId,
  speechSocketDirectory,
  speechSocketVolumeName,
} from "../core-container.js";
import type { ServiceSpec } from "./containers.js";
import { stacked } from "../stack.js";

// Speech-to-Phrase on the host, Sanctum's own image (deploy/speech-to-phrase):
// it recognizes sentences from its saved grammar or a training request.
// The core reaches Wyoming through a shared Unix socket. The service uses
// the network to download models and keeps them with its grammar in /data.

export const speechToPhraseImage =
  "ghcr.io/meetsanctum/sanctum-speech-to-phrase:2.2.0";
const socketPath = `${speechSocketDirectory}/wyoming.sock`;
export const speechToPhraseUrl = `unix://${socketPath}`;
export const speechToPhraseData = stacked("sanctum-speech-to-phrase-data");

/**
 * What it holds with a model loaded: German's Citrinet takes 1.6–2.1 GB on
 * a Pi 4, English's Parakeet 0.85–1.1 GB.
 */
export const speechToPhraseMemoryMb = 2_200;

export function speechToPhraseSpec(token: string): ServiceSpec {
  return {
    image: speechToPhraseImage,
    // The core's socket group can connect through its read-only mount.
    cmd: [
      "sh",
      "-ec",
      `chgrp ${socketGroupId} ${speechSocketDirectory}; chmod 2750 ${speechSocketDirectory}; umask 007; exec "$@"`,
      "speech-to-phrase",
      "python3",
      "/usr/src/sanctum_server.py",
      "--uri",
      speechToPhraseUrl,
    ],
    // The listener opens after the service restores the grammar.
    healthcheck: {
      Test: [
        "CMD",
        "python3",
        "-c",
        "import socket, sys; socket.socket(socket.AF_UNIX).connect(sys.argv[1])",
        socketPath,
      ],
      StartPeriod: 120_000_000_000,
    },
    env: [`SANCTUM_TRAIN_TOKEN=${token}`],
    volumes: [
      { name: speechToPhraseData, target: "/data" },
      { name: speechSocketVolumeName, target: speechSocketDirectory },
    ],
  };
}
