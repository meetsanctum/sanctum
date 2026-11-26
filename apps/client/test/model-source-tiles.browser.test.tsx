import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "vite";
import { expect, it } from "vitest";

import { NoModel } from "../src/models/no-model";

// The same viewport holds both cards to exercise container queries. Set
// SANCTUM_TEST_CHROMIUM to a Chromium executable to run the layout check.
const chromium = process.env.SANCTUM_TEST_CHROMIUM;

type Tile = { button: DOMRect; icon: DOMRect; label: DOMRect };
const center = (rect: DOMRect) => rect.x + rect.width / 2;

it.skipIf(!chromium)(
  "stacks sources in a narrow card and centers their labels under their icons in a wide card",
  async () => {
    const result = await build({
      root: fileURLToPath(new URL("..", import.meta.url)),
      logLevel: "silent",
      build: { write: false, rollupOptions: { input: "src/styles.css" } },
    });
    const css = [result]
      .flat()
      .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
      .find((file) => file.type === "asset" && file.fileName.endsWith(".css"));
    if (css?.type !== "asset") throw new Error("Missing client stylesheet");

    const card = (width: number) =>
      renderToStaticMarkup(
        <div style={{ width: `${width}rem` }}>
          <NoModel supportsSanctum firstChoiceRef={null} onChoose={() => {}} />
        </div>,
      );
    const directory = await mkdtemp(join(tmpdir(), "sanctum-source-tiles-"));
    try {
      const page = join(directory, "tiles.html");
      await writeFile(
        page,
        `<!doctype html><meta charset="utf-8"><style>${css.source}</style>
        ${card(30)}${card(44)}<output></output>
        <script>
          const measure = (group) => [...group.querySelectorAll('button')].map(button => {
            const label = [...button.querySelectorAll('span')].find(
              span => span.firstChild?.nodeType === Node.TEXT_NODE);
            const text = document.createRange();
            text.selectNodeContents(label);
            return {
              button: button.getBoundingClientRect(),
              icon: button.querySelector('svg').getBoundingClientRect(),
              label: text.getBoundingClientRect()
            };
          });
          document.querySelector('output').textContent = JSON.stringify(
            [...document.querySelectorAll('[role="group"]')].map(measure));
        </script>`,
      );
      const { stdout } = await promisify(execFile)(
        chromium!,
        [
          "--headless",
          "--disable-gpu",
          "--no-first-run",
          ...(process.platform === "darwin" ? ["--single-process"] : []),
          `--user-data-dir=${join(directory, "profile")}`,
          "--dump-dom",
          pathToFileURL(page).href,
        ],
        { timeout: 15_000 },
      );
      const measured = /<output>(.+)<\/output>/.exec(stdout)?.[1];
      expect(measured).toBeDefined();
      const [narrow, wide] = JSON.parse(measured!) as [Tile[], Tile[]];
      expect(narrow).toHaveLength(3);
      expect(wide).toHaveLength(3);
      for (const [index, { button, icon, label }] of narrow.entries()) {
        if (index > 0)
          expect(button.top).toBeGreaterThan(narrow[index - 1]!.button.bottom);
        expect(button.left).toBe(narrow[0]!.button.left);
        expect(label.left).toBeGreaterThan(icon.right);
        expect(label.top).toBeLessThan(icon.bottom);
      }
      for (const [index, { button, icon, label }] of wide.entries()) {
        if (index > 0)
          expect(button.left).toBeGreaterThan(wide[index - 1]!.button.right);
        expect(button.top).toBe(wide[0]!.button.top);
        expect(label.top).toBeGreaterThan(icon.bottom);
        expect(center(label)).toBeCloseTo(center(icon), 0);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
