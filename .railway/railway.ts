import { defineRailway, github, preserve, project, service } from "railway/iac";

// The website and the docs on Railway: two services that Railway builds and
// runs from this repository. `railway config plan` previews the changes and
// `railway config apply` applies them. Deploys never read this file.
// A custom domain is added on Railway itself, which this file cannot do.

const website = "@meetsanctum/website";
const docs = "@meetsanctum/docs";

export default defineRailway(() => {
  const site = service("website", {
    source: github("meetsanctum/sanctum", { branch: "main" }),
    build: {
      builder: "RAILPACK",
      // Turbo builds what the site depends on first, and keeps what it
      // built for the next build.
      buildCommand: `pnpm exec turbo run build --filter=${website}`,
      // What the site is built from: a push that changes nothing here
      // deploys nothing. Each pattern starts at the repository's root.
      watchPatterns: [
        "/apps/website/**",
        "/apps/client/src/brand.ts",
        "/assets/brand/**",
        "/packages/typescript-config/**",
        "/.dockerignore",
        "/package.json",
        "/pnpm-lock.yaml",
        "/pnpm-workspace.yaml",
        "/turbo.json",
      ],
    },
    start: `pnpm --filter ${website} start`,
    healthcheck: "/",
    env: {
      // Only the site's packages, not the whole workspace's.
      RAILPACK_INSTALL_CMD: `pnpm install --frozen-lockfile --prod=false --filter ${website}...`,
      // The key to apps/website/.env.production, set on Railway by hand and
      // kept there.
      DOTENV_PRIVATE_KEY_PRODUCTION: preserve(),
    },
  });
  // The docs: static files that Starlight builds, served by `serve` on the
  // port Railway gives the service. A start command of its own keeps
  // Railpack from serving them as a single-page app, which would answer
  // every unknown path with the welcome page instead of the 404 page.
  const docsSite = service("docs", {
    source: github("meetsanctum/sanctum", { branch: "main" }),
    build: {
      builder: "RAILPACK",
      buildCommand: `pnpm exec turbo run build --filter=${docs}`,
      watchPatterns: [
        "/apps/docs/**",
        "/apps/client/src/brand.ts",
        "/assets/brand/**",
        "/.dockerignore",
        "/.npmrc",
        "/package.json",
        "/pnpm-lock.yaml",
        "/pnpm-workspace.yaml",
        "/turbo.json",
      ],
    },
    start: `pnpm --filter ${docs} start`,
    healthcheck: "/",
    env: {
      RAILPACK_INSTALL_CMD: `pnpm install --frozen-lockfile --prod=false --filter ${docs}...`,
      ASTRO_TELEMETRY_DISABLED: "1",
    },
  });
  return project("website", { resources: [site, docsSite] });
});
