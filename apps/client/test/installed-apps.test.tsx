// @vitest-environment jsdom
import type { AppInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { useInstalledApps } from "../src/installed-apps";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const weather = { id: "sanctum.weather", name: "Weather" } as AppInfo;
const example = { id: "sanctum.example", name: "Example" } as AppInfo;

function InstalledStates() {
  apps = useInstalledApps(live);
  return (
    <>{apps.installed.map((app) => `${app.name} ${app.state}`).join(", ")}</>
  );
}

let container: HTMLDivElement;
let root: Root;
let live: ReturnType<typeof createLiveFeed>;
let apps: ReturnType<typeof useInstalledApps>;

function InstalledApps() {
  apps = useInstalledApps(live);
  return <>{apps.installed.map((app) => app.name).join(", ")}</>;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  live = createLiveFeed();
  await act(async () => root.render(<InstalledApps />));
});

afterEach(async () => {
  apps.stop();
  await act(async () => root.unmount());
  container.remove();
  vi.mocked(coreJson).mockReset();
  vi.unstubAllGlobals();
});

describe("the home's apps", () => {
  it("keeps an app added during an older list read, in name order", async () => {
    vi.mocked(coreJson).mockResolvedValueOnce([weather]);
    await act(async () => apps.read());

    let resolve!: (list: AppInfo[]) => void;
    const reading = new Promise<AppInfo[]>((done) => (resolve = done));
    vi.mocked(coreJson).mockReturnValueOnce(reading);
    let finished!: Promise<void>;
    await act(async () => {
      finished = apps.read();
    });
    await act(async () => live.publish({ type: "app", app: example }));
    expect(container.textContent).toBe("Example, Weather");

    await act(async () => {
      resolve([weather]);
      await finished;
    });
    expect(container.textContent).toBe("Example, Weather");
  });

  it("keeps an app announced during the first list read without showing a partial list", async () => {
    let resolve!: (list: AppInfo[]) => void;
    const reading = new Promise<AppInfo[]>((done) => (resolve = done));
    vi.mocked(coreJson).mockReturnValueOnce(reading);
    let finished!: Promise<void>;
    await act(async () => {
      finished = apps.read();
    });
    await act(async () => apps.appChanged(example));
    expect(container.textContent).toBe("");

    await act(async () => {
      resolve([weather]);
      await finished;
    });
    expect(container.textContent).toBe("Example, Weather");
  });

  it("keeps what a live message said of an app over a later answer to adding it", async () => {
    await act(async () => root.render(<InstalledStates />));
    vi.mocked(coreJson).mockResolvedValueOnce([weather]);
    await act(async () => apps.read());

    await act(async () =>
      live.publish({ type: "app", app: { ...example, state: "running" } }),
    );
    await act(async () => apps.appAdded({ ...example, state: "starting" }));
    expect(container.textContent).toContain("Example running");
    expect(container.textContent).not.toContain("Example starting");

    // Without a live message first, the answer brings it.
    const other = { id: "sanctum.other", name: "Other", state: "starting" };
    await act(async () => apps.appAdded(other as AppInfo));
    expect(container.textContent).toContain("Other starting");
  });
});
