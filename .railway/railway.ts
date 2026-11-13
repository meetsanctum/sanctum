import { defineRailway, github, preserve, project, service } from "railway/iac";

// The website on Railway: one service that Railway builds and runs from this
// repository. `railway config plan` shows what applying this file would
// change there and `railway config apply` changes it; deploys never read it.
// A custom domain is added on Railway itself, which this file cannot do.

const website = "@meetsanctum/website";

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
  return project("website", { resources: [site] });
});
