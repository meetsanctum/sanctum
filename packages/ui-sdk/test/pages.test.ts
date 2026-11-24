import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { digestOf, listFiles } from "../tools/files";
import { buildKit, sdkVersion } from "../tools/kit";
import { buildPages as buildPagesWith } from "../tools/pages";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, cp: vi.fn(fs.cp), rename: vi.fn(fs.rename) };
});

// `sanctum-pages build`: an app's pages, its ./ui export, built into pages/
// in its package with React and ui-sdk left out for the kit to answer.

const made: string[] = [];

// The kit, whose stylesheet a page's leaves out, built once.
let kitDir: string;
beforeAll(async () => {
  kitDir = await mkdtemp(join(tmpdir(), "sanctum-pages-kit-"));
  await buildKit(kitDir);
}, 60_000);
afterAll(() => rm(kitDir, { recursive: true, force: true }));

const buildPages = (dir: string) =>
  buildPagesWith(dir, { kitStylesheet: join(kitDir, "kit.css") });

afterEach(async () => {
  vi.mocked(cp).mockReset();
  vi.mocked(rename).mockReset();
  for (const dir of made.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// An app's package with its pages, as sanctum.example's.
async function app(
  page: string,
  exports: Record<string, string> = { "./ui": "./src/ui/index.tsx" },
) {
  const dir = await mkdtemp(join(tmpdir(), "sanctum-pages-"));
  made.push(dir);
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "@example/app", type: "module", exports }),
  );
  await mkdir(join(dir, "src/ui"), { recursive: true });
  await writeFile(join(dir, "src/ui/index.tsx"), page);
  return dir;
}

const page = `
import { useState } from "react";
import { PageBar, defineAppUi, icons, type PageProps } from "@meetsanctum/ui-sdk";

function MainPage(_props: PageProps) {
  const [count] = useState(0);
  return (
    <>
      <PageBar title="Example" />
      <p className="text-[15.5px] text-orange">
        <icons.Check aria-hidden="true" /> {count}
      </p>
    </>
  );
}

export default defineAppUi({ id: "sanctum.example", version: "1.0.0", pages: { main: MainPage } });
`;

describe("an app's pages", () => {
  it("build without React or ui-sdk, importing each icon from its own module", async () => {
    const dir = await app(page);
    const built = await buildPages(dir);

    const code = readFileSync(join(dir, "pages/index.js"), "utf8");
    expect(code).toMatch(/from"@meetsanctum\/ui-sdk"/);
    expect(code).toMatch(/from"react"/);
    expect(code).toMatch(/from"react\/jsx-runtime"/);
    expect(code).toMatch(/from"@meetsanctum\/ui-sdk\/icons\/check\.js"/);
    expect(code).not.toContain("lucide");
    expect(code.length).toBeLessThan(2_000);

    expect(built).toEqual({
      kit: sdkVersion(),
      digest: digestOf(built!.files),
      entry: "index.js",
      stylesheet: "pages.css",
      files: {
        "index.js": expect.objectContaining({
          type: "text/javascript; charset=utf-8",
        }),
        "pages.css": expect.objectContaining({
          type: "text/css; charset=utf-8",
        }),
      },
    });
    expect(
      JSON.parse(readFileSync(join(dir, "pages/pages.json"), "utf8")),
    ).toEqual(built);
    // What the build says it wrote is what's on disk.
    expect(await listFiles(join(dir, "pages"), ["pages.json"])).toEqual(
      built!.files,
    );
  }, 60_000);

  it("carry only their own classes, on Sanctum's theme, not the kit's", async () => {
    const dir = await app(page);
    await buildPages(dir);
    const css = readFileSync(join(dir, "pages/pages.css"), "utf8");
    expect(css).toContain(".text-orange{color:var(--ember-text)}");
    expect(css).toContain("font-size:15.5px");
    // Tailwind's base and Sanctum's tokens come with the kit.
    expect(css).not.toContain("--carbon");
    expect(css).not.toMatch(/@layer base\{/);
  }, 60_000);

  it("write colours with alpha as rgba(), never as hex", async () => {
    // The Shelly Wall Display's web view drops `#0000` and `#ffffff24`.
    const dir = await app(`
import { defineAppUi } from "@meetsanctum/ui-sdk";
function MainPage() {
  return <p className="bg-black/37">Example</p>;
}
export default defineAppUi({ id: "sanctum.example", version: "1.0.0", pages: { main: MainPage } });
`);
    await buildPages(dir);
    const css = readFileSync(join(dir, "pages/pages.css"), "utf8");
    expect(css).not.toMatch(/#(?:[\da-f]{4}|[\da-f]{8})(?![\w-])/i);
    expect(css).toContain("background-color:rgba(0,0,0,.37)");
  }, 60_000);

  it("leave out the utilities the kit's stylesheet has, so each comes once", async () => {
    const dir = await app(`
import { defineAppUi } from "@meetsanctum/ui-sdk";
function MainPage() {
  return <p className="m-0 mt-auto text-[15.5px]">Example</p>;
}
export default defineAppUi({ id: "sanctum.example", version: "1.0.0", pages: { main: MainPage } });
`);
    await buildPages(dir);
    const css = readFileSync(join(dir, "pages/pages.css"), "utf8");
    const kit = readFileSync(join(kitDir, "kit.css"), "utf8");
    // ui-sdk's components use both, so only the kit has them, in its order.
    for (const rule of [".m-0{", ".mt-auto{"]) {
      expect(kit).toContain(rule);
      expect(css).not.toContain(rule);
    }
    expect(css).toContain("font-size:15.5px");
  }, 60_000);

  it("don't build without the kit's stylesheet", async () => {
    const dir = await app(page);
    await expect(
      buildPagesWith(dir, { kitStylesheet: join(dir, "missing.css") }),
    ).rejects.toThrow(/build ui-sdk first/);
  });

  it("come out the same from the same sources", async () => {
    const dir = await app(page);
    const first = await buildPages(dir);
    const second = await buildPages(dir);
    expect(second?.digest).toBe(first?.digest);
  }, 60_000);

  it("keep the last good build when a rebuild fails, and the command fails", async () => {
    const dir = await app(page);
    const good = await buildPages(dir);
    await writeFile(
      join(dir, "src/ui/index.tsx"),
      "export default { this is not a page",
    );
    await expect(buildPages(dir)).rejects.toThrow();
    expect(
      JSON.parse(readFileSync(join(dir, "pages/pages.json"), "utf8")),
    ).toEqual(good);
    expect(existsSync(join(dir, "pages/index.js"))).toBe(true);
    expect(existsSync(join(dir, "node_modules/.sanctum-pages"))).toBe(false);
    expect(existsSync(join(dir, "node_modules/.sanctum-pages-next"))).toBe(
      false,
    );
  }, 60_000);

  it.each(["copying the old pages", "publishing the new pages"])(
    "keep the last good pages when %s fails",
    async (step) => {
      const dir = await app(page);
      const good = await buildPages(dir);
      await writeFile(
        join(dir, "src/ui/index.tsx"),
        page.replace("useState(0)", "useState(1)"),
      );
      const failure = new Error("The new pages could not take their place");
      if (step === "publishing the new pages") {
        vi.mocked(rename).mockRejectedValueOnce(failure);
      } else {
        vi.mocked(cp).mockRejectedValueOnce(failure);
      }

      await expect(buildPages(dir)).rejects.toThrow(failure);
      expect(await listFiles(join(dir, "pages"), ["pages.json"])).toEqual(
        good!.files,
      );
      expect(existsSync(join(dir, "node_modules/.sanctum-pages-next"))).toBe(
        false,
      );
      expect(
        existsSync(join(dir, "node_modules/.sanctum-pages-next-last")),
      ).toBe(false);
      // A failed publication does not prevent the next saved change building.
      expect((await buildPages(dir))?.digest).not.toBe(good?.digest);
    },
    60_000,
  );

  it("rebuild pages copied into a container image, whose directory cannot be moved", async () => {
    const dir = await app(page);
    const good = await buildPages(dir);
    const fs =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(rename).mockImplementation((from, to) => {
      if (from === join(dir, "pages")) {
        return Promise.reject(
          Object.assign(new Error("Cannot move a lower layer"), {
            code: "EXDEV",
          }),
        );
      }
      return fs.rename(from, to);
    });
    await writeFile(
      join(dir, "src/ui/index.tsx"),
      page.replace("useState(0)", "useState(1)"),
    );
    const built = await buildPages(dir);
    expect(built?.digest).not.toBe(good?.digest);
    expect(await listFiles(join(dir, "pages"), ["pages.json"])).toEqual(
      built!.files,
    );
  }, 60_000);

  it("fail to build with an icon picked by a name computed while the page runs", async () => {
    const dir = await app(`
import { defineAppUi, icons } from "@meetsanctum/ui-sdk";
function MainPage({ name }: { name: string }) {
  const Icon = icons[name as "Check"];
  return <Icon />;
}
export default defineAppUi({ id: "sanctum.example", version: "1.0.0", pages: { main: MainPage } });
`);
    await expect(buildPages(dir)).rejects.toThrow(/name each icon it uses/);
    expect(existsSync(join(dir, "node_modules/.sanctum-pages"))).toBe(false);
  }, 60_000);

  it("aren't built for a package with no ./ui", async () => {
    const dir = await app(page, { ".": "./index.js" });
    expect(await buildPages(dir)).toBeUndefined();
    expect(existsSync(join(dir, "pages"))).toBe(false);
  });

  it("removes an earlier build when the package no longer has pages", async () => {
    const dir = await app(page);
    await buildPages(dir);
    await writeFile(join(dir, "package.json"), JSON.stringify({ exports: {} }));
    expect(await buildPages(dir)).toBeUndefined();
    expect(existsSync(join(dir, "pages"))).toBe(false);
  }, 60_000);
});
