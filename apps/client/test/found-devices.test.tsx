// @vitest-environment jsdom
import type { PairingInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { foundHint, useAdding } from "../src/found-devices";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

const empty: PairingInfo = {
  until: null,
  joined: [],
  drivers: [],
  finders: [],
  found: [],
};
const found: PairingInfo = {
  ...empty,
  found: [
    {
      driver: "sanctum.example",
      key: "sensor",
      name: "Sensor",
      description: null,
      type: null,
      asks: [],
      refusals: {},
    },
  ],
};

function pendingReply() {
  let resolve!: (info: PairingInfo) => void;
  const promise = new Promise<PairingInfo>((done) => (resolve = done));
  return { promise, resolve };
}

const live = createLiveFeed();
let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
  vi.mocked(coreJson).mockReset();
});

async function show() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  root = createRoot(container);
  function Hint() {
    return <span>{foundHint(useAdding(live)?.found)}</span>;
  }
  await act(async () => root!.render(<Hint />));
  return container;
}

describe("found devices refreshes", () => {
  it("keeps a live update that arrives before an older read finishes", async () => {
    const reply = pendingReply();
    vi.mocked(coreJson).mockReturnValueOnce(reply.promise);
    const container = await show();
    await act(async () => live.publish({ type: "pairing", pairing: found }));
    await act(async () => reply.resolve(empty));

    expect(container.textContent).toBe("1 found on your network");
  });

  it("keeps the latest refresh when reads finish out of order", async () => {
    const first = pendingReply();
    const next = pendingReply();
    vi.mocked(coreJson)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(next.promise);
    const container = await show();
    await act(async () => live.refresh());
    await act(async () => next.resolve(found));
    await act(async () => first.resolve(empty));

    expect(container.textContent).toBe("1 found on your network");
  });
});
