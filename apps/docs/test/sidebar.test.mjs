import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the homepage sidebar links to Effects and motion under Screens", async () => {
  const homepage = await readFile(
    new URL("../dist/index.html", import.meta.url),
    "utf8",
  );
  const sidebar = homepage.match(
    /<nav\b[^>]*\saria-label="Main"[^>]*>([\s\S]*?)<\/nav>/,
  )?.[1];
  assert.ok(sidebar, "The homepage has a main sidebar");

  const groups = sidebar.matchAll(
    /<summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g,
  );
  const screens = [...groups].find(([, title]) =>
    />\s*Screens\s*</.test(title),
  );
  assert.ok(screens, "The main sidebar has a Screens group");
  assert.match(
    screens[2],
    /<a\b[^>]*\shref="\/screens\/effects-and-motion\/"/,
    "The Screens group links to Effects and motion",
  );
});
