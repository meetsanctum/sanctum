import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";
import { productName } from "../client/src/brand.ts";

// The documentation: Markdown pages in src/content/docs, with the images
// they show beside them, built by Starlight into static files in dist.
export default defineConfig({
  // DOCS_URL replaces it for a copy published at another address.
  site: process.env.DOCS_URL || "https://docs.meetsanctum.com",
  integrations: [
    starlight({
      title: productName,
      logo: {
        light: "@meetsanctum/brand/sanctum-logo.svg",
        dark: "@meetsanctum/brand/sanctum-logo-white.svg",
        replacesTitle: true,
      },
      // src/pages/favicon.svg.ts serves the brand's favicon here.
      favicon: "/favicon.svg",
      disable404Route: true,
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/meetsanctum/sanctum",
        },
      ],
      sidebar: [
        { label: "Welcome", link: "/" },
        {
          label: "Installing",
          items: [{ autogenerate: { directory: "install" } }],
        },
        {
          label: "People",
          items: [{ autogenerate: { directory: "people" } }],
        },
        {
          label: "Devices",
          items: [{ autogenerate: { directory: "devices" } }],
        },
        {
          label: "Apps",
          items: [{ autogenerate: { directory: "apps" } }],
        },
        {
          label: "Screens",
          items: [{ autogenerate: { directory: "screens" } }],
        },
        {
          label: "AI agents",
          items: [{ autogenerate: { directory: "ai-agents" } }],
        },
      ],
      customCss: [
        "@fontsource/inter/400.css",
        "@fontsource/inter/500.css",
        "@fontsource/inter/600.css",
        "./src/styles/theme.css",
      ],
      // A link to a page or heading that doesn't exist fails the build.
      plugins: [starlightLinksValidator()],
    }),
  ],
});
