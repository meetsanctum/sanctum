import path from "node:path";
import type { NextConfig } from "next";

// The repository's root: the page takes the product name from the client
// and the brand's files from assets/brand, both outside this folder.
const root = path.join(import.meta.dirname, "../..");

const config: NextConfig = {
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
};

export default config;
