import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix, relative } from "node:path";
import ts from "typescript";

import { lucideIcons, sdkModule } from "./icons.js";
import { chartsModule, sdkRoot, sdkVersion } from "./kit.js";

// ui-sdk's report of what the kit offers pages: each module's exports, by
// the import a page makes, ui-sdk's own and its charts', their declarations
// as TypeScript emits them, Lucide's icons by name and React's version.
// Pages built against one version of the kit open on any later one
// of its major, so what a version takes away needs a new major, and what it
// adds or changes at least a new minor: below 1.0, a new minor and a new
// patch. `api` writes the report and refuses a change its version doesn't
// cover; the tests fail while it's stale, and with SANCTUM_CONTRACT_BASE set
// to a git ref, when it breaks that ref's without the version saying so.
// Whether a changed declaration breaks pages is the author's call: it needs a
// major too if it does.

export const reportFile = "api.json";

export type ApiReport = {
  version: string;
  react: string;
  /** Each module's exports, by the import a page makes. */
  exports: Record<string, string[]>;
  icons: string[];
  declarations: Record<string, string[]>;
};

// The files each module the kit offers starts from.
const entries: Readonly<Record<string, string>> = {
  [sdkModule]: "src/kit.ts",
  [chartsModule]: "src/charts/index.ts",
};

// A report's exports by module. A report from before the kit had more than
// one module lists ui-sdk's alone.
const exportsOf = (report: ApiReport): Record<string, string[]> =>
  Array.isArray(report.exports)
    ? { [sdkModule]: report.exports as string[] }
    : report.exports;

type Change = "none" | "addition" | "removal";

const require = createRequire(import.meta.url);

// A chart declaration belongs to the public entry if the emitted types
// reach it. Imports used only to draw the charts are gone by this point.
function chartDeclarations(declarations: Record<string, string[]>) {
  const reached = new Set<string>();
  const visit = (file: string) => {
    const lines = declarations[file];
    if (!lines || reached.has(file)) return;
    reached.add(file);
    for (const { fileName } of ts.preProcessFile(lines.join("\n"))
      .importedFiles) {
      if (fileName.startsWith(".")) {
        visit(posix.join(posix.dirname(file), `${fileName}.d.ts`));
      }
    }
  };
  visit("charts/index.d.ts");
  return reached;
}

/** What ui-sdk's kit offers pages now, at its current version. */
export function apiOf(): ApiReport {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(sdkRoot, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    },
  );
  if (!parsed) throw new Error("No tsconfig.json in ui-sdk");
  const files = Object.values(entries).map((file) => join(sdkRoot, file));
  const outDir = join(sdkRoot, "dist/api");
  const program = ts.createProgram(files, {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    sourceMap: false,
    removeComments: true,
    outDir,
    rootDir: join(sdkRoot, "src"),
  });
  const checker = program.getTypeChecker();
  const exports = Object.fromEntries(
    Object.entries(entries).map(([module, file]) => {
      const source = program.getSourceFile(join(sdkRoot, file));
      const moduleSymbol = source && checker.getSymbolAtLocation(source);
      if (!moduleSymbol) throw new Error(`ui-sdk's ${file} has no exports`);
      return [
        module,
        checker
          .getExportsOfModule(moduleSymbol)
          .map((symbol) => symbol.name)
          .sort(),
      ];
    }),
  );

  const declarations: Record<string, string[]> = {};
  const emitted = program.emit(
    undefined,
    (fileName, text) => {
      if (!fileName.endsWith(".d.ts")) return;
      declarations[relative(outDir, fileName).split("\\").join("/")] = text
        .trimEnd()
        .split("\n");
    },
    undefined,
    true,
  );
  if (emitted.emitSkipped) {
    throw new Error(
      ts.formatDiagnostics(emitted.diagnostics, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => sdkRoot,
        getNewLine: () => "\n",
      }),
    );
  }
  const publicCharts = chartDeclarations(declarations);
  const sorted = Object.fromEntries(
    Object.entries(declarations)
      .filter(([file]) => !file.startsWith("charts/") || publicCharts.has(file))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const icons = [...lucideIcons().keys()]
    .filter((name) => !name.startsWith("Lucide") && !name.endsWith("Icon"))
    .sort();
  const { version: react } = JSON.parse(
    readFileSync(require.resolve("react/package.json"), "utf8"),
  ) as { version: string };
  return {
    version: sdkVersion(),
    react,
    exports,
    icons,
    declarations: sorted,
  };
}

const majorOf = (version: string) => Number(version.split(".")[0]);

/** What going from one report to another takes away or adds. */
export function changeBetween(before: ApiReport, after: ApiReport): Change {
  const gone = (from: string[], to: string[]) =>
    from.some((name) => !to.includes(name));
  const exportsBefore = exportsOf(before);
  const exportsAfter = exportsOf(after);
  if (
    Object.entries(exportsBefore).some(([module, names]) =>
      gone(names, exportsAfter[module] ?? []),
    ) ||
    gone(before.icons, after.icons) ||
    majorOf(before.react) !== majorOf(after.react)
  ) {
    return "removal";
  }
  const same =
    before.react === after.react &&
    JSON.stringify(exportsBefore) === JSON.stringify(exportsAfter) &&
    JSON.stringify(before.icons) === JSON.stringify(after.icons) &&
    JSON.stringify(before.declarations) === JSON.stringify(after.declarations);
  return same ? "none" : "addition";
}

function parts(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`${version} isn't a version`);
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

/** The lowest version after `from` that covers a change: a major for a removal, a minor for an addition, one step down below 1.0. */
export function versionFor(from: string, change: Change): string | undefined {
  if (change === "none") return undefined;
  const [major, minor, patch] = parts(from);
  if (major === 0) {
    return change === "removal"
      ? `0.${minor + 1}.0`
      : `0.${minor}.${patch + 1}`;
  }
  return change === "removal" ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
}

function atLeast(version: string, lowest: string) {
  const [a, b, c] = parts(version);
  const [x, y, z] = parts(lowest);
  return a !== x ? a > x : b !== y ? b > y : c >= z;
}

/** Why a version doesn't cover going from `before` to `after`, if it doesn't. */
export function uncovered(before: ApiReport, after: ApiReport) {
  const lowest = versionFor(before.version, changeBetween(before, after));
  if (lowest === undefined || atLeast(after.version, lowest)) return undefined;
  const what =
    changeBetween(before, after) === "removal"
      ? "takes away exports, icons or React's major"
      : "adds to or changes its exports";
  return `ui-sdk ${after.version} ${what} since ${before.version}: raise its version to ${lowest} or later`;
}

const reportPath = () => join(sdkRoot, reportFile);
const textOf = (report: ApiReport) => `${JSON.stringify(report, null, 2)}\n`;

function committed(): ApiReport | undefined {
  return existsSync(reportPath())
    ? (JSON.parse(readFileSync(reportPath(), "utf8")) as ApiReport)
    : undefined;
}

// The report a git ref has, or nothing where it has none.
function reportAt(ref: string): ApiReport | undefined {
  try {
    const text = execFileSync(
      "git",
      ["show", `${ref}:packages/ui-sdk/${reportFile}`],
      { cwd: sdkRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(text) as ApiReport;
  } catch (error) {
    const said = String((error as { stderr?: unknown }).stderr ?? "");
    if (/does not exist|exists on disk, but not in/.test(said))
      return undefined;
    throw error;
  }
}

/** Writes the report, refusing a change the version doesn't cover. */
export function writeApiReport() {
  const after = apiOf();
  const before = committed();
  const refused = before && uncovered(before, after);
  if (refused) throw new Error(refused);
  writeFileSync(reportPath(), textOf(after));
  return `Wrote ui-sdk's ${reportFile} for ${after.version}`;
}

/** Fails while the report is stale, or breaks the base ref's without a version that says so. */
export function checkApiReport(base = process.env.SANCTUM_CONTRACT_BASE) {
  const kept = committed();
  const now = apiOf();
  if (!kept || textOf(kept) !== textOf(now)) {
    throw new Error(
      `ui-sdk's ${reportFile} is stale: run pnpm --filter @meetsanctum/ui-sdk api`,
    );
  }
  const before = base ? reportAt(base) : undefined;
  const refused = before && uncovered(before, now);
  if (refused) throw new Error(`${refused} (against ${base})`);
  return `ui-sdk's ${reportFile} is current`;
}
