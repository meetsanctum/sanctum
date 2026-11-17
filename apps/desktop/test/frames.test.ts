import { describe, expect, it } from "vitest";

import { createFrameList, entryOf } from "../src/frames.js";

// The frames the client shows apps' pages in, held to the address the
// client named for each, and their loads to that page and the kit.

const code = "0123456789abcdef0123456789abcdef";
const ticket = `page_${"A".repeat(43)}`;
const origin = "https://192.168.1.20:4100";
const folder = `/pages/${ticket}/apps/sanctum.weather/0123456789abcdef/`;
const entry = `${origin}${folder}#hello=${code}`;

describe("a frame's address", () => {
  it("is an app page's entry on the core, with its code", () => {
    expect(entryOf(entry)).toEqual({
      url: entry,
      origin,
      ticket,
      folder,
    });
    expect(
      entryOf(`http://127.0.0.1:42994${folder}#hello=${code}`),
    ).toBeDefined();
  });

  it.each([
    ["without its code", `${origin}${folder}`],
    ["with another hash", `${origin}${folder}#other=${code}`],
    ["at a file of the page", `${origin}${folder}index.js#hello=${code}`],
    ["at the kit", `${origin}/pages/${ticket}/kit/0123/#hello=${code}`],
    ["with a query", `${origin}${folder}?x=1#hello=${code}`],
    ["with a user", `https://me@192.168.1.20:4100${folder}#hello=${code}`],
    ["of the app's own scheme", `app://sanctum${folder}#hello=${code}`],
    ["of a file", `file://${folder}#hello=${code}`],
    ["of data", `data:text/html,hi#hello=${code}`],
    ["outside /pages/", `${origin}/api/apps/#hello=${code}`],
    [
      "climbing out",
      `${origin}/pages/${ticket}/apps/x/../../kit/0/#hello=${code}`,
    ],
  ])("isn't one %s", (_what, url) => {
    expect(entryOf(url)).toBeUndefined();
  });
});

describe("a frame", () => {
  const named = () => {
    const frames = createFrameList();
    expect(frames.allow(entry)).toBe(true);
    return frames;
  };

  it("goes only to the address named for it, its own entry again on a reload, whatever its #", () => {
    const frames = named();
    expect(frames.mayNavigate(entry)).toBe(true);
    // A reload after the page moved its own #.
    expect(frames.mayNavigate(`${origin}${folder}#moved`)).toBe(true);
    expect(frames.mayNavigate(`${origin}${folder}`)).toBe(true);
    for (const url of [
      `${origin}/pages/${ticket}/apps/sanctum.moods/0123456789abcdef/#hello=${code}`,
      `${origin}/pages/${ticket}/apps/sanctum.weather/fedcba9876543210/#hello=${code}`,
      `https://example.com${folder}#hello=${code}`,
      "app://sanctum/",
      "about:blank",
    ]) {
      expect(frames.mayNavigate(url), url).toBe(false);
    }
  });

  it("goes nowhere once its address ends, or before one is named", () => {
    const frames = named();
    frames.end(entry);
    expect(frames.mayNavigate(entry)).toBe(false);
    expect(createFrameList().allow(`${origin}/api/health`)).toBe(false);
  });

  it("loads its entry, its own page's files and the kit under its ticket", () => {
    const frames = named();
    expect(frames.mayLoad("", entry, true)).toBe(true);
    // Chromium may leave out what follows the # in a frame's request.
    expect(frames.mayLoad("", `${origin}${folder}`, true)).toBe(true);
    for (const url of [
      `${origin}${folder}index.js`,
      `${origin}${folder}chunks/day-1a2b.js`,
      `${origin}/pages/${ticket}/kit/9edd26f3b3eae8d8/react.js`,
      `${origin}/pages/${ticket}/kit/9edd26f3b3eae8d8/assets/inter.woff2`,
    ]) {
      expect(frames.mayLoad(entry, url, false), url).toBe(true);
    }
    // The same page with its # moved is still that page.
    expect(
      frames.mayLoad(
        `${origin}${folder}#moved`,
        `${origin}${folder}index.js`,
        false,
      ),
    ).toBe(true);
  });

  it("loads nothing else", () => {
    const frames = named();
    const other = `page_${"B".repeat(43)}`;
    for (const url of [
      `${origin}/api/health`,
      `${origin}/api/devices`,
      `${origin}/pages/${ticket}/apps/sanctum.moods/0123456789abcdef/index.js`,
      `${origin}/pages/${other}/kit/9edd26f3b3eae8d8/react.js`,
      `https://192.168.1.21:4100${folder}index.js`,
      `https://example.com/track.gif`,
      `${origin}${folder}index.js?leak=1`,
    ]) {
      expect(frames.mayLoad(entry, url, false), url).toBe(false);
    }
    // Another app's page, or one never named, loads no frame.
    expect(
      frames.mayLoad(
        "",
        `${origin}/pages/${ticket}/apps/sanctum.moods/0123456789abcdef/`,
        true,
      ),
    ).toBe(false);
    // A frame the client never named loads nothing at all.
    expect(
      createFrameList().mayLoad(entry, `${origin}${folder}index.js`, false),
    ).toBe(false);
  });
});
