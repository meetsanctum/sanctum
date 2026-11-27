import { languages } from "@meetsanctum/app-sdk/languages";

import { stacked } from "../stack.js";
import type { ServiceSpec } from "./containers.js";

// Piper on the host, which turns the core's words into speech for smart
// speakers to play. It speaks Wyoming over TCP and keeps the voices it
// downloads in a data volume of its own, fetching a voice the first time
// it's asked for one. It holds one voice at a time, the home's English one
// to begin with, so the first announcement doesn't wait for it to load.
//
// Only the core reaches it, on the `sanctum` network, over which it
// downloads voices too.

export const piperImage = "rhasspy/wyoming-piper:2.5.4";
const port = 10200;
export const piperUrl = `tcp://${stacked("sanctum-piper")}:${port}`;
export const piperData = stacked("sanctum-piper-data");

/** What it holds with one medium voice loaded, and room for a second. */
export const piperMemoryMb = 512;

export function piperSpec(): ServiceSpec {
  return {
    image: piperImage,
    // The image's entrypoint already listens on every address at this port
    // and keeps voices in /data.
    cmd: ["--voice", languages.en.voice],
    volumes: [{ name: piperData, target: "/data" }],
    memoryMb: piperMemoryMb,
  };
}
