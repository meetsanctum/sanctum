import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { build, type Plugin } from "vite";

import { digestOf, filesOf, type BuiltFile } from "./files.js";
import { iconImports, iconModules } from "./icons.js";
import { kitImports, quietLogs, sdkRoot, sdkVersion } from "./kit.js";
import { withoutKitRules } from "./styles.js";

// `sanctum-pages build`, run in an app's package as part of its build: its
// pages, its `./ui` export, built into pages/ in the package, which ships
// with it. React and ui-sdk stay out, since the kit answers them, and so do
// the classes ui-sdk's components use, which come with the kit's
// stylesheet. pages.json says which kit the pages were built against and
// what they hold.

const require = createRequire(import.meta.url);

export const pagesFolder = "pages";
export const pagesManifestName = "pages.json";

export type PagesManifest = {
  /** The kit version they were built against: any of its major from this one on. */
  kit: string;
  digest: string;
  entry: string;
  stylesheet: string | null;
  files: Record<string, BuiltFile>;
};

type PackageJson = { name?: string; exports?: Record<string, unknown> };

// The package's `./ui` export, which is where its pages start.
async function uiEntry(packageDir: string) {
  const packageJson = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  ) as PackageJson;
  const ui = packageJson.exports?.["./ui"];
  const path =
    typeof ui === "string"
      ? ui
      : typeof ui === "object" && ui !== null
        ? ((ui as { default?: string }).default ?? undefined)
        : undefined;
  return path === undefined ? undefined : resolve(packageDir, path);
}

// A package's folder, found along the module paths, for one whose exports
// answer only a style condition, which require can't ask for.
function packageFolder(name: string) {
  for (const base of require.resolve.paths(name) ?? []) {
    const folder = join(base, name);
    if (existsSync(join(folder, "package.json"))) return realpathSync(folder);
  }
  throw new Error(`No ${name} for ui-sdk`);
}

// What a page's own stylesheet holds: its classes, on Tailwind's theme and
// Sanctum's, without anything the kit's stylesheet already has.
function stylesheetOf(uiFolder: string) {
  return [
    "@layer theme, base, components, utilities;",
    `@import "${require.resolve("tailwindcss/theme.css")}" layer(theme);`,
    `@import "${require.resolve("tailwindcss/utilities.css")}" layer(utilities) source(none);`,
    `@reference "${join(packageFolder("tw-animate-css"), "dist/tw-animate.css")}";`,
    `@reference "${require.resolve("shadcn/tailwind.css")}";`,
    `@reference "${join(sdkRoot, "src/theme.css")}";`,
    `@source "${uiFolder}";`,
    "",
  ].join("\n");
}

const isKitImport = (id: string) =>
  Object.hasOwn(kitImports, id) || id.startsWith(iconModules);

// The page's stylesheet without what the kit's already has (./styles.ts).
function kitRulesLeftOut(kitCss: string): Plugin {
  return {
    name: "sanctum-kit-rules-left-out",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        for (const [name, file] of Object.entries(bundle)) {
          if (file.type !== "asset" || !name.endsWith(".css")) continue;
          const text =
            typeof file.source === "string"
              ? file.source
              : new TextDecoder().decode(file.source);
          file.source = withoutKitRules(text, kitCss);
        }
      },
    },
  };
}

/** The kit's stylesheet as ui-sdk's build writes it. */
export const builtKitStylesheet = join(sdkRoot, "dist/kit/kit.css");

/** Builds the pages of the app in `packageDir`, if it has any. */
export async function buildPages(
  packageDir: string,
  options: { kitStylesheet?: string } = {},
): Promise<PagesManifest | undefined> {
  const kitStylesheet = options.kitStylesheet ?? builtKitStylesheet;
  const outDir = join(packageDir, pagesFolder);
  // The build goes aside and takes pages/' place whole once it succeeds, so
  // one that fails, as a half-written page saved in development does,
  // leaves the last good one, and the command fails. A package without
  // pages any more keeps none.
  const next = join(packageDir, "node_modules/.sanctum-pages-next");
  await rm(next, { recursive: true, force: true });
  const ui = await uiEntry(packageDir);
  if (ui === undefined) {
    await rm(outDir, { recursive: true, force: true });
    return undefined;
  }
  if (!existsSync(ui)) throw new Error(`No ${ui}: it's the package's ./ui`);
  if (!existsSync(kitStylesheet)) {
    throw new Error(
      `No kit stylesheet at ${kitStylesheet}: build ui-sdk first, since a page's stylesheet leaves out what the kit's has`,
    );
  }
  const kitCss = await readFile(kitStylesheet, "utf8");
  // The entry and stylesheet the build starts from, out of the way.
  const work = join(packageDir, "node_modules/.sanctum-pages");
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  await writeFile(join(work, "pages.css"), stylesheetOf(dirname(ui)));
  await writeFile(
    join(work, "index.js"),
    [`export { default } from "${ui}";`, `import "./pages.css";`, ""].join(
      "\n",
    ),
  );

  try {
    const result = await build({
      configFile: false,
      root: packageDir,
      // What a home serves, whatever the environment that builds it says.
      mode: "production",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      oxc: { jsx: { runtime: "automatic", development: false } },
      // Each file says where the others are relative to it, wherever the core serves them.
      base: "./",
      logLevel: "warn",
      plugins: [tailwindcss(), iconImports(), kitRulesLeftOut(kitCss)],
      build: {
        outDir: next,
        emptyOutDir: true,
        minify: true,
        target: "es2022",
        modulePreload: false,
        copyPublicDir: false,
        reportCompressedSize: false,
        rolldownOptions: {
          input: { index: join(work, "index.js") },
          external: isKitImport,
          onLog: quietLogs,
          preserveEntrySignatures: "exports-only",
          output: {
            format: "es",
            entryFileNames: "[name].js",
            chunkFileNames: "chunks/[name]-[hash].js",
            assetFileNames: (asset) =>
              asset.names.some((name) => name.endsWith(".css"))
                ? "pages.css"
                : "assets/[name]-[hash][extname]",
          },
        },
      },
    });
    const files = filesOf(result);
    const manifest: PagesManifest = {
      kit: sdkVersion(),
      digest: digestOf(files),
      entry: "index.js",
      stylesheet: Object.hasOwn(files, "pages.css") ? "pages.css" : null,
      files,
    };
    await writeFile(
      join(next, pagesManifestName),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const last = `${next}-last`;
    await rm(last, { recursive: true, force: true });
    // A directory copied into an image can live in a read-only lower layer,
    // where moving it fails with EXDEV. Keep a copy until publication succeeds.
    const hasPreviousPages = await cp(outDir, last, { recursive: true }).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      },
    );
    try {
      await rm(outDir, { recursive: true, force: true });
      await rename(next, outDir);
    } catch (error) {
      if (hasPreviousPages) {
        await rm(outDir, { recursive: true, force: true });
        await rename(last, outDir);
      }
      throw error;
    }
    await rm(last, { recursive: true, force: true });
    return manifest;
  } catch (error) {
    await rm(next, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
