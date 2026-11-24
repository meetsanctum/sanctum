import { describe, expect, it } from "vitest";

import {
  changeBetween,
  checkApiReport,
  uncovered,
  versionFor,
  type ApiReport,
} from "../tools/api";

// ui-sdk's report of what the kit offers pages, module by module. Pages
// built against one version open on any later one of its major, so what a
// version takes away needs a new major and what it adds or changes at least
// a new minor: below 1.0, a new minor and a new patch.

const sdk = "@meetsanctum/ui-sdk";
const charts = "@meetsanctum/ui-sdk/charts";
const exports = (root: string[], chartsExports = ["LineChart"]) => ({
  [sdk]: root,
  [charts]: chartsExports,
});

const report = (changes: Partial<ApiReport> = {}): ApiReport => ({
  version: "0.1.0",
  react: "19.3.1",
  exports: exports(["Button", "PageBar"]),
  icons: ["Check", "House"],
  declarations: {
    "page-bar.d.ts": ["export declare function PageBar(): void;"],
  },
  ...changes,
});

describe("a change to what the kit offers", () => {
  it("is nothing when the report is the same", () => {
    expect(changeBetween(report(), report())).toBe("none");
    expect(versionFor("0.1.0", "none")).toBeUndefined();
  });

  it("takes away when an export or icon goes, or React's major changes", () => {
    expect(
      changeBetween(report(), report({ exports: exports(["Button"]) })),
    ).toBe("removal");
    expect(
      changeBetween(
        report(),
        report({ exports: exports(["Button", "PageBar"], []) }),
      ),
    ).toBe("removal");
    // An export moved to another module is gone from the one pages import.
    expect(
      changeBetween(
        report(),
        report({ exports: exports(["Button", "PageBar", "LineChart"], []) }),
      ),
    ).toBe("removal");
    expect(changeBetween(report(), report({ icons: ["House"] }))).toBe(
      "removal",
    );
    expect(changeBetween(report(), report({ react: "20.0.0" }))).toBe(
      "removal",
    );
  });

  it("adds when an export or icon comes, a declaration changes or React moves within its major", () => {
    expect(
      changeBetween(
        report(),
        report({ exports: exports(["Button", "PageBar", "Slider"]) }),
      ),
    ).toBe("addition");
    expect(
      changeBetween(
        report(),
        report({
          exports: exports(
            ["Button", "PageBar"],
            ["LineChart", "WeekRangeChart"],
          ),
        }),
      ),
    ).toBe("addition");
    expect(
      changeBetween(
        report(),
        report({
          declarations: {
            "page-bar.d.ts": [
              "export declare function PageBar(x: number): void;",
            ],
          },
        }),
      ),
    ).toBe("addition");
    expect(changeBetween(report(), report({ react: "19.4.0" }))).toBe(
      "addition",
    );
  });

  it("reads a report from before the charts' module as ui-sdk's exports alone", () => {
    const older = {
      ...report({ exports: {} }),
      exports: ["Button", "PageBar"],
    } as unknown as ApiReport;
    expect(changeBetween(older, report())).toBe("addition");
    expect(changeBetween(older, report({ exports: exports(["Button"]) }))).toBe(
      "removal",
    );
  });

  it("needs a new major to take away, and a new minor to add, one step down below 1.0", () => {
    expect(versionFor("0.1.0", "removal")).toBe("0.2.0");
    expect(versionFor("0.1.3", "addition")).toBe("0.1.4");
    expect(versionFor("1.4.2", "removal")).toBe("2.0.0");
    expect(versionFor("1.4.2", "addition")).toBe("1.5.0");
  });

  it("is refused when the version doesn't cover it, and taken when it does", () => {
    const before = report();
    expect(uncovered(before, report({ exports: exports(["Button"]) }))).toBe(
      "ui-sdk 0.1.0 takes away exports, icons or React's major since 0.1.0: raise its version to 0.2.0 or later",
    );
    expect(
      uncovered(
        before,
        report({ version: "0.1.1", exports: exports(["Button"]) }),
      ),
    ).toMatch(/raise its version to 0\.2\.0/);
    expect(
      uncovered(
        before,
        report({ version: "0.2.0", exports: exports(["Button"]) }),
      ),
    ).toBeUndefined();
    expect(
      uncovered(
        before,
        report({ exports: exports(["Button", "PageBar", "Slider"]) }),
      ),
    ).toMatch(/adds to or changes its exports.*0\.1\.1 or later/);
    expect(
      uncovered(
        before,
        report({
          version: "0.1.1",
          exports: exports(["Button", "PageBar", "Slider"]),
        }),
      ),
    ).toBeUndefined();
    expect(uncovered(before, report({ version: "0.1.0" }))).toBeUndefined();
  });
});

describe("ui-sdk's committed report", () => {
  it("is current, and against the branch a pull request goes into, covered by its version", () => {
    expect(checkApiReport(process.env.SANCTUM_CONTRACT_BASE)).toBe(
      "ui-sdk's api.json is current",
    );
  }, 60_000);
});
