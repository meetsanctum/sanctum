// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChooseHost } from "../src/auth/ChooseHost";
import { hostStatus } from "../src/auth/device";
import type { Shell } from "../src/shell";

vi.mock("../src/auth/device", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth/device")>()),
  hostStatus: vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // A plain browser: no discovery, only the core it was pointed at.
  vi.stubGlobal("sanctumShell", {
    platform: "web",
    deviceName: async () => "Web browser",
    discovery: null,
    credentials: {
      isSecure: async () => false,
      load: async () => null,
      save: async () => {},
      forget: async () => {},
    },
    trust: null,
    preferences: { get: async () => null, set: async () => {} },
  } satisfies Shell);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("choosing a home in a plain browser", () => {
  it("keeps asking the core while it says it is still looking", async () => {
    vi.mocked(hostStatus)
      .mockRejectedValueOnce(new Error("not up yet"))
      .mockResolvedValueOnce({
        hostId: "53137026-a6e2-4307-bc63-b88dc79df0ec",
        homeId: "37a029f8-aaee-427b-b73e-3d3f7e19a4b0",
        claimed: true,
      });
    await act(async () => root.render(<ChooseHost onChoose={() => {}} />));
    await wait(0);

    expect(container.querySelector("h1")?.textContent).toBe(
      "No home found yet",
    );
    expect(container.textContent).toContain("Still looking…");

    await wait(5_000);

    expect(hostStatus).toHaveBeenCalledTimes(2);
    expect(container.querySelector("h1")?.textContent).toBe("Choose your home");
    expect(container.querySelector("button")?.textContent).toBe("Sanctum");
  });

  it("cancels the scheduled retry when leaving the chooser", async () => {
    vi.mocked(hostStatus).mockRejectedValue(new Error("not up yet"));
    await act(async () => root.render(<ChooseHost onChoose={() => {}} />));
    expect(container.textContent).toContain("Still looking…");

    await act(async () => root.render(null));
    await wait(10_000);

    expect(hostStatus).toHaveBeenCalledTimes(1);
  });

  it("aborts a pending status request when leaving the chooser", async () => {
    vi.mocked(hostStatus).mockImplementation(() => new Promise(() => {}));
    await act(async () => root.render(<ChooseHost onChoose={() => {}} />));
    const signal = vi.mocked(hostStatus).mock.calls[0]![1];
    expect(signal?.aborted).toBe(false);

    await act(async () => root.render(null));

    expect(signal?.aborted).toBe(true);
  });
});
