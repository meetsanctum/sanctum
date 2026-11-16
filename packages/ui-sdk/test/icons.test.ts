import { describe, expect, it } from "vitest";

import { lucideIcons, transformIcons } from "../tools/icons";

// A page names each icon it uses, as icons.Check, and its build imports each
// from the kit's own module for it, so a page loads only those.

const icons = lucideIcons();
const turn = (code: string) => transformIcons(code, "page.js", icons);

describe("Lucide's icons", () => {
  it("are known by every name they export, to the file holding them", () => {
    expect(icons.get("Check")).toBe("check");
    expect(icons.get("CheckIcon")).toBe("check");
    expect(icons.get("LucideCheck")).toBe("check");
    expect(icons.get("CalendarClock")).toBe("calendar-clock");
    expect(icons.get("Clock1")).toBe("clock-1");
  });
});

describe("a page's icons", () => {
  it("each become an import of that icon's own module", () => {
    const out = turn(
      [
        `import { PageBar, icons } from "@meetsanctum/ui-sdk";`,
        `export const a = [icons.Check, icons.CalendarClock, icons.Check];`,
        `export const b = PageBar;`,
      ].join("\n"),
    );
    expect(out).toContain(`import { PageBar } from "@meetsanctum/ui-sdk";`);
    expect(out).toContain(
      `import __sanctum_icon_Check from "@meetsanctum/ui-sdk/icons/check.js";`,
    );
    expect(out).toContain(
      `import __sanctum_icon_CalendarClock from "@meetsanctum/ui-sdk/icons/calendar-clock.js";`,
    );
    expect(out).toContain(
      "[__sanctum_icon_Check, __sanctum_icon_CalendarClock, __sanctum_icon_Check]",
    );
    expect(out).not.toMatch(/\bicons\./);
  });

  it("keep their name when imported under another, and drop the import when it held only icons", () => {
    const out = turn(
      [
        `import { icons as glyphs } from "@meetsanctum/ui-sdk";`,
        `export const a = glyphs.Plus;`,
      ].join("\n"),
    );
    expect(out).not.toContain(`from "@meetsanctum/ui-sdk";`);
    expect(out).toContain(`export const a = __sanctum_icon_Plus;`);
  });

  it("leave a module that doesn't use them as it is", () => {
    const code = `import { PageBar } from "@meetsanctum/ui-sdk";\nexport const a = PageBar;`;
    expect(turn(code)).toBeUndefined();
    expect(
      turn(`export const icons = { Check: 1 }; export const a = icons.Check;`),
    ).toBeUndefined();
  });

  it("aren't confused with a property of the same name", () => {
    const out = turn(
      [
        `import { icons } from "@meetsanctum/ui-sdk";`,
        `export const a = { icons: 1 }.icons + icons.House;`,
      ].join("\n"),
    );
    expect(out).toContain("{ icons: 1 }.icons + __sanctum_icon_House");
  });

  it("fail the build when one is picked by a name computed while the page runs", () => {
    const code = [
      `import { icons } from "@meetsanctum/ui-sdk";`,
      `export const pick = (name) => icons[name];`,
    ].join("\n");
    expect(() => turn(code)).toThrow(/name each icon it uses, as icons\.Check/);
  });

  it("fail the build when the icons are passed around whole", () => {
    expect(() =>
      turn(
        `import { icons } from "@meetsanctum/ui-sdk";\nexport const all = Object.keys(icons);`,
      ),
    ).toThrow(/name each icon/);
  });

  it("fail the build for a name that isn't one of Lucide's", () => {
    expect(() =>
      turn(
        `import { icons } from "@meetsanctum/ui-sdk";\nexport const a = icons.NoSuchIcon;`,
      ),
    ).toThrow(/icons\.NoSuchIcon isn't one of Lucide's icons/);
  });

  it("fail the build for ui-sdk imported whole, or its icons passed on", () => {
    expect(() =>
      turn(
        `import * as sdk from "@meetsanctum/ui-sdk";\nexport const a = sdk.PageBar;`,
      ),
    ).toThrow(/by name/);
    expect(() => turn(`export { icons } from "@meetsanctum/ui-sdk";`)).toThrow(
      /re-exports/,
    );
  });
});
