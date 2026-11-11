// Packages the desktop app as a macOS disk image:
// `pnpm --filter @meetsanctum/desktop package`, after which the image is in
// release/. The main process is bundled into one file with its
// dependencies, so the app carries no node_modules; beside it go the
// preload and the built client (src/main.ts finds it there).
import builder from "electron-builder";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { productName } from "../../client/src/brand.ts";
import { dmgIcons, dmgIconSize, dmgWindow } from "./artwork.ts";
import { giveOwnUuid } from "./macho.ts";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const appId = "com.meetsanctum.desktop";
const require = createRequire(import.meta.url);
const staged = join(desktop, "build", "app");
// The brand's files, under their own licence (assets/brand/LICENSE).
const brand = join(desktop, "..", "..", "assets", "brand");
const { version } = require("../package.json") as { version: string };
const electronVersion = (
  require("electron/package.json") as { version: string }
).version;
const clientDist = join(
  dirname(require.resolve("@meetsanctum/client/package.json")),
  "dist",
);

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: desktop, encoding: "utf8" }).trim();
// macOS wants a number for the build (CFBundleVersion): the count of
// commits. The About panel shows the commit instead (src/main.ts), marked
// when the working tree has changes.
const buildNumber = git("rev-list", "--count", "HEAD");
const commit =
  git("rev-parse", "--short=7", "HEAD") +
  (git("status", "--porcelain") ? "-dirty" : "");

rmSync(staged, { recursive: true, force: true });
mkdirSync(staged, { recursive: true });
await build({
  entryPoints: [join(desktop, "src", "main.ts")],
  outfile: join(staged, "main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["electron"],
  define: { "process.env.SANCTUM_BUILD": JSON.stringify(commit) },
  // The CommonJS dependencies (bonjour-service) require Node's modules.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  logLevel: "warning",
});
await build({
  entryPoints: [join(desktop, "src", "preload.cts")],
  outfile: join(staged, "preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  logLevel: "warning",
});
cpSync(clientDist, join(staged, "client"), { recursive: true });
cpSync(join(desktop, "..", "..", "LICENSE"), join(staged, "LICENSE"));
// The bundled client and main process also contain the Apache-licensed SDKs
// and catalog apps, whose terms travel with their compiled code.
cpSync(
  join(desktop, "..", "..", "packages", "app-sdk", "LICENSE"),
  join(staged, "LICENSE-Apache-2.0"),
);
cpSync(join(brand, "LICENSE"), join(staged, "LICENSE-brand"));
writeFileSync(
  join(staged, "package.json"),
  JSON.stringify(
    {
      name: "sanctum-desktop",
      productName,
      description: `The ${productName} desktop app`,
      version,
      type: "module",
      main: "main.js",
    },
    null,
    2,
  ),
);

await builder.build({
  projectDir: desktop,
  targets: builder.Platform.MAC.createTarget("dmg", builder.Arch.arm64),
  publish: "never",
  config: {
    appId,
    productName,
    copyright: "Copyright © 2026 the Sanctum authors",
    buildVersion: buildNumber,
    electronVersion,
    electronLanguages: ["en"],
    directories: {
      app: staged,
      output: "release",
      buildResources: "resources",
    },
    asar: true,
    // Executables with UUIDs of their own, so macOS asks for and keeps the
    // Local Network permission for this app, not for Electron
    // (scripts/macho.ts). Signing comes after.
    afterPack: ({ appOutDir, packager }) => {
      const name = packager.appInfo.productFilename;
      const contents = join(appOutDir, `${name}.app`, "Contents");
      const frameworks = join(contents, "Frameworks");
      const helpers = readdirSync(frameworks)
        .filter((entry) => entry.endsWith(".app"))
        .map((helper) =>
          join(
            frameworks,
            helper,
            "Contents",
            "MacOS",
            basename(helper, ".app"),
          ),
        );
      for (const executable of [join(contents, "MacOS", name), ...helpers]) {
        giveOwnUuid(executable, appId);
      }
    },
    // The bundle holds every dependency: no node_modules to install, rebuild
    // or copy, not even the desktop package's own.
    beforeBuild: async () => false,
    artifactName: "${productName}-${version}-${arch}.${ext}",
    // Nothing but the app's own code runs as the app, which holds the
    // keychain key for the home's token.
    electronFuses: {
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      enableCookieEncryption: true,
      grantFileProtocolExtraPrivileges: false,
    },
    mac: {
      category: "public.app-category.lifestyle",
      icon: join(brand, "sanctum-macos-icon.icns"),
      // Ad-hoc, so no notarisation either. Hardened runtime would refuse
      // Electron's own frameworks under an ad-hoc signature.
      identity: "-",
      hardenedRuntime: false,
      notarize: false,
      darkModeSupport: true,
      extendInfo: {
        NSLocalNetworkUsageDescription: `${productName} finds your home on this network.`,
        NSBonjourServices: ["_sanctum._tcp"],
      },
    },
    dmg: {
      title: "${productName}",
      // No block map: nothing updates itself from these images.
      writeUpdateInfo: false,
      background: "resources/dmg-background.tiff",
      window: dmgWindow,
      iconSize: dmgIconSize,
      contents: [
        dmgIcons.app,
        { ...dmgIcons.applications, type: "link", path: "/Applications" },
      ],
    },
  },
});
