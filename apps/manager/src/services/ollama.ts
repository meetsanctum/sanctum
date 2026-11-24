import type { ServiceSpec } from "./containers.js";
import { stacked } from "../stack.js";

// Ollama on the host, which answers the home's AI model and keeps its models
// in a data volume of its own. It answers one request at a time with a short
// queue and keeps one model loaded, so a small host isn't asked for more than
// it has, and its cloud models and web search are off, so what's asked stays
// in the home. It runs on the processor, within a cap on memory and cores.
//
// The core reaches it on the `sanctum` network. An app that holds the service
// reaches it on a network shared only with Ollama (apps/service-networks.ts).
// Ollama downloads models over the `sanctum` network.

export const ollamaImage = "ollama/ollama:0.40.18";
const port = 11434;
export const ollamaUrl = `http://${stacked("sanctum-ollama")}:${port}`;
export const ollamaData = stacked("sanctum-ollama-data");

/** Half the host's memory, which models need most. */
export const ollamaMemoryMb = (hostMemoryMb: number) =>
  Math.floor(hostMemoryMb / 2);

/** Every core but one, which stays for the core and the apps. */
const ollamaCpus = (hostCpus: number) => Math.max(1, hostCpus - 1);

export function ollamaSpec(host: {
  memoryMb: number;
  cpus: number;
}): ServiceSpec {
  return {
    image: ollamaImage,
    env: [
      `OLLAMA_HOST=0.0.0.0:${port}`,
      "OLLAMA_NO_CLOUD=1",
      "OLLAMA_NUM_PARALLEL=1",
      "OLLAMA_MAX_QUEUE=4",
      "OLLAMA_MAX_LOADED_MODELS=1",
      // The model in use stays loaded, so a question doesn't wait for it to
      // load: its memory is Ollama's share of the host already.
      "OLLAMA_KEEP_ALIVE=-1",
    ],
    volumes: [{ name: ollamaData, target: "/root/.ollama" }],
    memoryMb: ollamaMemoryMb(host.memoryMb),
    cpus: ollamaCpus(host.cpus),
  };
}
