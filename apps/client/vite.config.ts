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
    },
  },
});
