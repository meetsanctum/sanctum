// @vitest-environment jsdom
import type { AppInfo, DeviceInfo } from "@meetsanctum/app-sdk";
import {
  createAppClient,
  createLiveFeed,
  frameBridge,
  type CoreBridge,
} from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostedApp } from "../src/apps";
import { DeviceFrame } from "../src/frames/device-frame";
import { CoreError } from "../src/core-fetch";
import { forgetPageTicket } from "../src/frames/page-ticket";

// An app's page for a device in its frame, inside the device's detail: as
// tall as the page says, the device sent on as it changes, and an Escape the
// page leaves closing the detail.

const answers = vi.hoisted(() => ({
  pages: (): Promise<unknown> => Promise.resolve({ digest: "page" }),
}));
vi.mock("../src/core-fetch", async () => ({
  CoreError: (
    await vi.importActual<typeof import("../src/core-fetch")>(
      "../src/core-fetch",
    )
  ).CoreError,
  currentCredential: () => ({ token: "client" }),
  coreJson: (path: string) =>
    path === "/api/pages/ticket"
      ? Promise.resolve({
          ticket: "page_ticket",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          kit: { version: "0.1.4", bridge: frameBridge, digest: "kit" },
        })
      : answers.pages(),
}));

const info: AppInfo = {
  id: "sanctum.esphome",
  name: "ESPHome",
  version: "0.2.0",
  icon: null,
  pages: [],
  permissions: [],
  requests: [],
  state: "running",
  settings: null,
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
};
const app: HostedApp = {
  info,
  client: createAppClient(info, {
    json: vi.fn() as unknown as CoreBridge["json"],
    live: createLiveFeed(),
    ask: vi.fn(),
  }),
};
const device = { id: "esp-1", name: "Hall sensor" } as unknown as DeviceInfo;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  forgetPageTicket();
  answers.pages = () => Promise.resolve({ digest: "page" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const show = (onEscape: () => void, shown: DeviceInfo = device) =>
  act(async () => {
    root.render(
      <DeviceFrame
        app={app}
        page="esphome.device"
        title="Device"
        device={shown}
        household={undefined}
        isAway={false}
        onEscape={onEscape}
      />,
    );
  });

const frame = () => container.querySelector("iframe")!;

// The page says hello as the kit would; its end of the port, with what the
// shell said to it.
async function hello() {
  await vi.waitFor(() => expect(frame().getAttribute("src")).toBeTruthy());
  const target = frame().contentWindow!;
  const code = new URL(frame().src).hash.replace("#hello=", "");
  let port: MessagePort | undefined;
  vi.spyOn(target, "postMessage").mockImplementation(((
    _data: unknown,
    _to: string,
    ports: MessagePort[],
  ) => {
    port = ports[0];
  }) as typeof target.postMessage);
  window.dispatchEvent(
    Object.assign(new Event("message"), {
      data: { sanctum: "hello", code, bridge: frameBridge },
      source: target,
    }),
  );
  const said: { type: string }[] = [];
  port!.onmessage = (event) => said.push(event.data as { type: string });
  return { port: port!, said };
}

describe("a device page in its frame", () => {
  it("shows nothing until the page is ready, then as tall as it says", async () => {
    await show(() => {});
    const { port, said } = await hello();
    await vi.waitFor(() => expect(said[0]?.type).toBe("setup"));
    expect(said[0]).toMatchObject({ page: "esphome.device", device });
    expect(frame().style.height).toBe("0px");
    port.postMessage({ type: "size", height: 240 });
    port.postMessage({ type: "ready" });
    await vi.waitFor(() => expect(frame().style.height).toBe("240px"));
    expect(frame().className).not.toContain("invisible");
    port.close();
  });

  it("sends the device on as it changes, and closes the detail on an Escape the page leaves", async () => {
    const onEscape = vi.fn();
    await show(onEscape);
    const { port, said } = await hello();
    await vi.waitFor(() => expect(said[0]?.type).toBe("setup"));
    await show(onEscape, { ...device, name: "Porch sensor" });
    await vi.waitFor(() =>
      expect(said).toContainEqual({
        type: "device",
        device: { ...device, name: "Porch sensor" },
      }),
    );
    port.postMessage({ type: "key", key: "Escape" });
    await vi.waitFor(() => expect(onEscape).toHaveBeenCalledOnce());
    port.close();
  });

  it("says what it needs in the detail, with no top bar, when its pages don't fit the home's kit", async () => {
    answers.pages = () =>
      Promise.reject(
        new CoreError(404, "not_found", { error: "not_found", needs: "pages" }),
      );
    await show(() => {});
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "This page needs an update of ESPHome",
      ),
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("header")).toBeNull();
  });
});
