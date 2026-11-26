import type { ServiceSpec } from "./containers.js";
import { stacked } from "../stack.js";

// Speech-to-Phrase on the host, Sanctum's own image (deploy/speech-to-phrase):
// it turns what a smart speaker heard into words, knowing only the sentences
// the core teaches it, and answers from its saved grammar as it starts. It
// speaks Wyoming over TCP and keeps its models, grammar and last lesson in a
// data volume of its own, downloading a language's model the first time it
// is taught one.
//
// The core reaches it on the `sanctum` network, as it reaches Piper, over
// which it downloads models too. Teaching it needs a token the manager makes
// once and gives the container and the core, so nothing else on that network
// can change what it hears.

export const speechToPhraseImage =
  "ghcr.io/meetsanctum/sanctum-speech-to-phrase:2.2.0";
const port = 10300;
export const speechToPhraseUrl = `tcp://${stacked("sanctum-speech-to-phrase")}:${port}`;
export const speechToPhraseData = stacked("sanctum-speech-to-phrase-data");

/**
 * What it holds with a model loaded: German's Citrinet takes 1.6–2.1 GB on
 * a Pi 4, English's Parakeet 0.85–1.1 GB.
 */
export const speechToPhraseMemoryMb = 2_200;

export function speechToPhraseSpec(token: string): ServiceSpec {
  return {
    image: speechToPhraseImage,
    // The image's command listens on every address at this port, keeps its
    // data in /data and ends speech by its own voice detector.
    env: [`SANCTUM_TRAIN_TOKEN=${token}`],
    volumes: [{ name: speechToPhraseData, target: "/data" }],
    // Healthy once it answers a describe, after restoring its saved grammar.
    healthcheck: {
      Test: [
        "CMD-SHELL",
        `echo '{"type": "describe"}' | nc -w 1 localhost ${port} | grep -q '"asr"'`,
      ],
      StartPeriod: 120_000_000_000,
    },
  };
}
