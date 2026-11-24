import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build, type BuildOptions, type Plugin, type UserConfig } from "vite";

import { digestOf, filesOf } from "./files.js";
import { iconModules, lucideDir, lucideIcons, sdkModule } from "./icons.js";

// The kit: React, React DOM, React's JSX runtime and ui-sdk, as the modules
// every app page imports, served by the core from its own image so every app
// shares one look and one set of fixes. It comes in parts, so a page loads
// what it uses: React, ui-sdk without its icons, and one module per icon.
// kit.json says what it is and which module answers which import.

/** The kit's bridge with the shell, which a client must speak to show its pages. */
export const bridgeVersion = 4;

// The folder holding ui-sdk's package.json, from a file inside it, whether
// that's the built tools in dist/tools or their sources.
function packageRoot(from: string) {
  let folder = dirname(fileURLToPath(from));
  for (;;) {
    const manifest = join(folder, "package.json");
    if (
      existsSync(manifest) &&
      (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name ===
        "@meetsanctum/ui-sdk"
    ) {
      return folder;
    }
    const up = dirname(folder);
    if (up === folder) throw new Error("ui-sdk's tools are outside ui-sdk");
    folder = up;
  }
}

/** ui-sdk's own folder. */
export const sdkRoot = packageRoot(import.meta.url);

const require = createRequire(import.meta.url);

/** Which module of the kit answers each import a page makes. */
export const kitImports: Readonly<Record<string, string>> = {
  react: "react.js",
  "react/jsx-runtime": "react-jsx-runtime.js",
  "react-dom": "react-dom.js",
  "react-dom/client": "react-dom-client.js",
  [sdkModule]: "ui-sdk.js",
  [iconModules]: "icons/",
};

export type KitManifest = {
  version: string;
  bridge: number;
  digest: string;
  stylesheet: string;
  imports: Record<string, string>;
};

/** ui-sdk's version, which is the kit's. */
export function sdkVersion(): string {
  const { version } = JSON.parse(
    readFileSync(join(sdkRoot, "package.json"), "utf8"),
  ) as { version: string };
  return version;
}

// React ships CommonJS, so its modules are written out name by name, from
// what its production build exports.
function reExport(specifier: string) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const exported = require(specifier) as Record<string, unknown>;
    const names = Object.keys(exported).filter(
      (name) => name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name),
    );
    return [
      `import module from "${specifier}";`,
      "export default module;",
      `export const { ${names.join(", ")} } = module;`,
    ].join("\n");
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

const virtual = "\0sanctum-kit:";

type OnLog = NonNullable<NonNullable<BuildOptions["rolldownOptions"]>["onLog"]>;

/**
 * Leaves out what a build says that asks nothing of anyone: Radix's
 * `"use client"`, which says nothing outside React's server components and
 * which bundling drops, as it should, and how long plugins took on a busy
 * machine.
 */
export const quietLogs: OnLog = (level, log, handler) => {
  if (log.code === "MODULE_LEVEL_DIRECTIVE" || log.code === "PLUGIN_TIMINGS") {
    return;
  }
  handler(level, log);
};

// lightningcss's Features.HexAlphaColors, which Vite's CSS minifier takes,
// written out: ui-sdk is Apache-2.0 and lightningcss MPL-2.0, so ui-sdk
// doesn't depend on it directly. The kit's test fails if the flag stops
// lowering those colours.
const hexAlphaColors = 1 << 14;

/**
 * How the kit's and pages' stylesheets are written: a colour with alpha as
 * rgba() or transparent, never the minifier's hex (`#0000`, `#ffffff24`),
 * which the Shelly Wall Display's web view drops.
 */
export const stylesheetOptions: UserConfig["css"] = {
  lightningcss: { include: hexAlphaColors },
};

function kitModules(files: ReadonlySet<string>): Plugin {
  const lucide = lucideDir();
  return {
    name: "sanctum-kit-modules",
    resolveId: (id) => (id.startsWith(virtual) ? id : null),
    // Inter's stylesheets offer each face as WOFF too, for browsers older
    // than any a page runs in; only the WOFF2 files are kept.
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        for (const [name, file] of Object.entries(bundle)) {
          if (file.type !== "asset") continue;
          if (name.endsWith(".woff")) {
            delete bundle[name];
          } else if (name.endsWith(".css")) {
            const text =
              typeof file.source === "string"
                ? file.source
                : new TextDecoder().decode(file.source);
            file.source = text.replace(
              /,\s*url\([^)]*\.woff\)\s*format\(["']woff["']\)/g,
              "",
            );
          }
        }
      },
    },
    load(id) {
      if (!id.startsWith(virtual)) return null;
      const what = id.slice(virtual.length);
      if (what === "ui-sdk") {
        return [
          `export * from "${join(sdkRoot, "src/kit.ts")}";`,
          `import "${join(sdkRoot, "src/kit.css")}";`,
        ].join("\n");
      }
      if (what.startsWith("icon:")) {
        const file = what.slice("icon:".length);
        if (!files.has(file)) throw new Error(`No icon ${file}`);
        return `export { default } from "${join(lucide, "dist/esm/icons", `${file}.mjs`)}";`;
      }
      return reExport(what);
    },
  };
}

/** Builds the kit into `outDir`, by default ui-sdk's dist/kit. */
export async function buildKit(
  outDir = join(sdkRoot, "dist/kit"),
): Promise<KitManifest> {
  const files = new Set(lucideIcons().values());
  const input: Record<string, string> = {
    react: `${virtual}react`,
    "react-jsx-runtime": `${virtual}react/jsx-runtime`,
    "react-dom": `${virtual}react-dom`,
    "react-dom-client": `${virtual}react-dom/client`,
    "ui-sdk": `${virtual}ui-sdk`,
  };
  for (const file of files) input[`icons/${file}`] = `${virtual}icon:${file}`;

  const result = await build({
    configFile: false,
    root: sdkRoot,
    // What a home serves, whatever the environment that builds it says.
    mode: "production",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    oxc: { jsx: { runtime: "automatic", development: false } },
    // Each file says where the others are relative to it, wherever the core serves the kit.
    base: "./",
    logLevel: "warn",
    plugins: [kitModules(files), tailwindcss()],
    css: stylesheetOptions,
    resolve: { dedupe: ["react", "react-dom"] },
    build: {
      outDir,
      emptyOutDir: true,
      minify: true,
      target: "es2022",
      modulePreload: false,
      copyPublicDir: false,
      reportCompressedSize: false,
      rolldownOptions: {
        input,
        onLog: quietLogs,
        preserveEntrySignatures: "strict",
        output: {
          format: "es",
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: (asset) =>
            asset.names.some((name) => name.endsWith(".css"))
              ? "kit.css"
              : "assets/[name]-[hash][extname]",
        },
      },
    },
  });

  const manifest: KitManifest = {
    version: sdkVersion(),
    bridge: bridgeVersion,
    digest: digestOf(filesOf(result)),
    stylesheet: "kit.css",
    imports: { ...kitImports },
  };
  writeFileSync(
    join(outDir, "kit.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
