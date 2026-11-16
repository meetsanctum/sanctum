import { buildKit } from "./kit.js";
import { buildPages } from "./pages.js";

// `sanctum-pages`:
//   build        in an app's package: its pages into pages/
//   kit          in ui-sdk: the kit into dist/kit
//   api [--check] in ui-sdk: write or check the report of its exports

export async function main(args: string[]): Promise<string | undefined> {
  const [command, ...rest] = args;
  switch (command) {
    case "build": {
      const pages = await buildPages(process.cwd());
      return pages
        ? `Built pages ${pages.digest} against kit ${pages.kit}`
        : "No pages: the package has no ./ui export";
    }
    case "kit": {
      const kit = await buildKit();
      return `Built kit ${kit.version} (${kit.digest})`;
    }
    case "api": {
      // TypeScript is ui-sdk's own development dependency, needed only here.
      const { checkApiReport, writeApiReport } = await import("./api.js");
      return rest.includes("--check") ? checkApiReport() : writeApiReport();
    }
    default:
      throw new Error("Usage: sanctum-pages build | kit | api [--check]");
  }
}
