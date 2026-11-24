/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { Features } from "lightningcss";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

import { displayBridge } from "./dev/display.ts";
import { productName } from "./src/brand.ts";

const coreUrl = process.env.SANCTUM_CORE_URL ?? "http://127.0.0.1:4100";
const displayPort =
  process.env.SANCTUM_DISPLAY_ENABLED === "true"
    ? Number(process.env.SANCTUM_DISPLAY_PORT)
    : undefined;
const touchLog =
  process.env.SANCTUM_DISPLAY_TOUCHES === "true"
    ? fileURLToPath(
        new URL("../../.sanctum-display-touches.jsonl", import.meta.url),
      )
    : undefined;
const frameLog =
  process.env.SANCTUM_DISPLAY_FRAMES === "true"
    ? fileURLToPath(
        new URL("../../.sanctum-display-frames.jsonl", import.meta.url),
      )
    : undefined;
// The client built for the display by `build:display`.
const builtDir = fileURLToPath(new URL("./dist-display", import.meta.url));

function brand(): Plugin {
  return {
    name: "sanctum-brand",
    transformIndexHtml: (html) =>
      html.replaceAll("%PRODUCT_NAME%", productName),
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    brand(),
    displayPort ? displayBridge({ touchLog, frameLog, builtDir }) : undefined,
  ],
  css: {
    // The build's minifier writes a colour with alpha as hex, `#0000` or
    // `#ffffff24`, which the Shelly Wall Display's web view drops: buttons'
    // transparent borders came out in the text colour and their reset
    // background as the browser's grey. Written as rgba() or transparent,
    // every browser reads them.
    lightningcss: { include: Features.HexAlphaColors },
  },
  resolve: {
    // The alias the shadcn components import from (components.json).
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    // The apps' pages and ui-sdk use the shell's React.
    dedupe: ["react", "react-dom"],
  },
  server: {
    // Use the display port directly so this worktree always serves its own stack.
    host: displayPort ? "0.0.0.0" : undefined,
    port: displayPort ?? 5173,
    strictPort: Boolean(displayPort),
    fs: {
      // Keep the display logs local, even when Vite serves the whole workspace.
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem,key,p12,pfx,cer,der}",
        ".npmrc",
        ".yarnrc.yml",
        "**/.git/**",
        ".sanctum-display-*.jsonl",
      ],
    },
    proxy: {
      // The live WebSocket too.
      "/api": { target: coreUrl, ws: true },
      // Apps' pages in their frames, which the core lets a shell at this
      // address show when CORE_ALLOWED_ORIGINS names it.
      "/pages": { target: coreUrl },
    },
  },
  test: {
    // Client tests can exceed Vitest's five-second default when CI runs
    // package suites in parallel.
    testTimeout: 20_000,
  },
});
