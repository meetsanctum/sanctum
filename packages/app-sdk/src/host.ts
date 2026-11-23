// What the machine Sanctum runs on has, for an app that has to know whether
// something fits before it starts it, as Ollama's page does before it
// downloads a model. Readings the host can't give are null.

export type HostResources = {
  processor: {
    /** Such as "Raspberry Pi 4 Model B" or "Intel(R) N150", where the host says. */
    name: string | null;
    cores: number;
    /**
     * Whether it has the vector instructions AI models run quickly on
     * without graphics: AVX2 on x86, or the dot product on ARM.
     */
    matrixInstructions: boolean | null;
  };
  memory: { totalBytes: number; availableBytes: number } | null;
  storage: { freeBytes: number } | null;
};
