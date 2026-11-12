import type { StaticManifest } from "@meetsanctum/app-sdk";
import { manifestDigest, manifestFileName } from "@meetsanctum/app-sdk/package";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ApartPackage, Origin } from "./host.js";

// Reads apps' packages as the core knows them: by their manifests, never
// importing their code. The core gives each the origin of where it came from,
// never one from the package.

type Log = (message: string) => void;

// An app at the version staged in its folder, as its manifest there has it.
export async function loadApartPackage(
  packagesDir: string,
  appId: string,
  folder: string,
  origin: Origin,
): Promise<ApartPackage> {
  const text = await readFile(
    join(packagesDir, appId, folder, manifestFileName),
  );
  const manifest = JSON.parse(text.toString("utf8")) as StaticManifest;
  if (manifest.id !== appId) {
    throw new Error(`This package holds ${manifest.id}, not ${appId}`);
  }
  return { apart: { manifest, digest: manifestDigest(text), folder }, origin };
}

// Every app the core is told to run, as `id@folder`. One that doesn't load is
// logged and left out, as any other package.
export async function loadApartPackages(
  apart: readonly string[],
  packagesDir: string,
  log: Log,
): Promise<ApartPackage[]> {
  const packages: ApartPackage[] = [];
  for (const each of apart) {
    const [appId = "", folder = ""] = each.split("@");
    try {
      packages.push(
        await loadApartPackage(packagesDir, appId, folder, "official"),
      );
    } catch (error) {
      log(
        `apps: ${each} was not loaded (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  return packages;
}

// The ids of the apps the core's image ships for its manager to stage, one
// folder each, read from their manifests. None, where there is no such folder,
// as in a development stack, whose apps come from the worktree.
export async function shippedApps(dir: string, log: Log): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ids: string[] = [];
  for (const entry of entries.filter((each) => each.isDirectory())) {
    try {
      const text = await readFile(
        join(dir, entry.name, manifestFileName),
        "utf8",
      );
      ids.push((JSON.parse(text) as { id: string }).id);
    } catch (error) {
      log(
        `apps: ${entry.name} has no manifest to read (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  return ids.sort();
}
