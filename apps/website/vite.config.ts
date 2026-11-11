import { fileURLToPath } from "node:url";
import { defineConfig, normalizePath, type Plugin } from "vite";

// The product name is defined once, in the client; the site shares it.
import { productName } from "../client/src/brand.ts";

// The brand's files the page shows, from assets/brand, which keeps them under
// their own licence.
const brandFiles = {
  "%BRAND_MARK%": "../../assets/brand/sanctum-favicon.svg",
  "%BRAND_PHOTO%": "../../assets/brand/photos/living-room-dusk.jpg",
};

function brand(): Plugin {
  return {
    name: "sanctum-brand",
    transformIndexHtml: {
      // Resolve the brand's files before Vite bundles HTML assets. In
      // development, files outside the website root need Vite's filesystem
      // URL.
      order: "pre",
      handler: (html, context) =>
        Object.entries(brandFiles).reduce(
          (page, [placeholder, path]) =>
            page.replaceAll(
              placeholder,
              context.server
                ? `/@fs/${normalizePath(fileURLToPath(new URL(path, import.meta.url)))}`
                : path,
            ),
          html.replaceAll("%PRODUCT_NAME%", productName),
        ),
    },
  };
}

export default defineConfig({
  plugins: [brand()],
  server: {
    port: 5174,
  },
});
