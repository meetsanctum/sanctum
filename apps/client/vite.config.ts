/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

import { productName } from "./src/brand.ts";

const coreUrl = process.env.SANCTUM_CORE_URL ?? "http://127.0.0.1:4100";

function brand(): Plugin {
  return {
    name: "sanctum-brand",
    transformIndexHtml: (html) =>
      html.replaceAll("%PRODUCT_NAME%", productName),
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), brand()],
  resolve: {
    // The alias the shadcn components import from (components.json).
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    // The apps' pages and ui-sdk use the shell's React.
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 5173,
    proxy: {
      // The live WebSocket too.
      "/api": { target: coreUrl, ws: true },
      // Apps' pages in their frames, which the core lets a shell at this
      // address show when CORE_ALLOWED_ORIGINS names it.
      "/pages": { target: coreUrl },
    },
  },
  test: {
    // On CI these tests share the runner's four cores with every other
    // package's, and a Settings test that takes 0.1 s on a Mac took 5.4 s
    // there, past Vitest's 5 s default. A test that hangs still fails.
    testTimeout: 20_000,
  },
});
