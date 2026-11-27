// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useArtwork } from "../src/artwork";
import { setCredential } from "../src/core-fetch";
import { setCoreBaseUrl } from "../src/core-url";

const host = "http://core.test";
const credential = {
  url: host,
  token: "client_one",
  pin: null,
  hostId: "host",
  homeId: "home",
};
const hashOf = (index: number) => index.toString(16).padStart(64, "0");
const picture = () =>
  new Response(new Blob(["picture"], { type: "image/png" }));

function Image({ hash }: { hash: string }) {
  const artwork = useArtwork(hash);
  if (artwork === "missing") return <span>missing</span>;
  return artwork && <img src={artwork.url} alt="" />;
}

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
const createUrl = vi.fn();
const revokeUrl = vi.fn();
const fetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    fetch.mockReset().mockImplementation(async () => picture()),
  );
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = createUrl
        .mockReset()
        .mockImplementation(() => `blob:${createUrl.mock.calls.length}`);
      static override revokeObjectURL = revokeUrl.mockReset();
    },
  );
  setCoreBaseUrl(host);
  setCredential(credential);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  setCoreBaseUrl(null);
  setCredential(null);
  vi.unstubAllGlobals();
});

describe("player artwork", () => {
  it("keeps displayed URLs alive when their picture leaves the cache", async () => {
    const render = (index: number) =>
      act(async () => {
        root.render(
          <>
            <Image hash={hashOf(0)} />
            <Image hash={hashOf(index)} />
          </>,
        );
      });
    await render(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const first = container.querySelector("img")!.getAttribute("src");

    for (let index = 1; index <= 16; index += 1) await render(index);

    expect(fetch).toHaveBeenCalledTimes(17);
    expect(container.querySelector("img")!.getAttribute("src")).toBe(first);
    expect(revokeUrl).not.toHaveBeenCalledWith(first);
    await act(async () => root.render(null));
    expect(revokeUrl).toHaveBeenCalledWith(first);
  });

  it("checks for artwork again when the client credential changes", async () => {
    const render = () =>
      act(async () => root.render(<Image hash={hashOf(0)} />));
    await render();
    expect(container.querySelector("img")).not.toBeNull();
    setCredential({ ...credential, token: "client_two" });
    fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await render();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("missing");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      new Headers(fetch.mock.calls[1]![1].headers).get("authorization"),
    ).toBe("Bearer client_two");
  });

  it("is missing at once for a name that isn't a hash, fetching nothing", async () => {
    await act(async () => root.render(<Image hash="not-a-hash" />));
    expect(container.textContent).toBe("missing");
    expect(fetch).not.toHaveBeenCalled();
  });
});
