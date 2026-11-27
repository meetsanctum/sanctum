// @vitest-environment jsdom
import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { frameBridge, type FromFrame, type ToFrame } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { deferred } from "./deferred";
import { weather } from "./home-shell-fixtures";
import {
  container,
  homeData,
  mockCoreJson,
  openFromOverview,
  pageTitle,
  refresh,
} from "./home-shell-harness";
import { forgetPageTicket } from "../src/frames/page-ticket";
import { light } from "./settings-devices-fixtures";

const app = {
  ...weather,
  id: "sanctum.example",
  name: "Example",
  permissions: ["devices.read:audio"],
  pages: ["main", "setup"],
};

function speaker(id: string, name: string): DeviceInfo {
  return light(id, name, {
    type: "smart-speaker",
    driver: app.id,
    capabilities: [
      {
        id: "audio",
        kind: "audio",
        features: {
          listens: true,
          announces: true,
          mutes: true,
          muteSwitch: false,
        },
        state: { muted: false },
        observed: null,
        desired: null,
        sync: "synced",
        setBy: null,
        changedAt: null,
      },
    ],
  });
}

const speakers = [
  speaker("office", "Office Speaker"),
  speaker("hall", "Hall Speaker"),
];
let lookup: Promise<DeviceInfo[]> | undefined;
let ports: MessagePort[];

beforeAll(() => import("../src/settings"));

beforeEach(async () => {
  forgetPageTicket();
  ports = [];
  lookup = undefined;
  homeData.devices = speakers;
  homeData.installed = [app];
  const usual = mockCoreJson.getMockImplementation()!;
  mockCoreJson.mockImplementation(async (path, init) => {
    if (path === "/api/pages/ticket") {
      return {
        ticket: "ticket",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
        kit: { version: "0.1.41", bridge: frameBridge, digest: "kit" },
      };
    }
    if (path === `/api/pages/apps/${app.id}`) return { digest: "page" };
    if (path === "/api/devices" && init?.app === app.id)
      return lookup ?? speakers;
    return usual(path, init);
  });
  await refresh();
  await openFromOverview(app.name);
});

afterEach(() => {
  for (const port of ports) port.close();
  vi.restoreAllMocks();
  forgetPageTicket();
});

async function connect() {
  const frame = () => container.querySelector<HTMLIFrameElement>("iframe[src]");
  await waitFor(() => expect(frame()).not.toBeNull());
  const iframe = frame()!;
  const source = iframe.contentWindow!;
  const code = new URL(iframe.src).hash.slice("#hello=".length);
  const said: ToFrame[] = [];
  let port!: MessagePort;
  vi.spyOn(source, "postMessage").mockImplementation(((
    _,
    _origin,
    transfer: MessagePort[],
  ) => {
    port = transfer[0]!;
    ports.push(port);
    port.onmessage = (event: MessageEvent<ToFrame>) => said.push(event.data);
  }) as typeof source.postMessage);
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { sanctum: "hello", code, bridge: frameBridge },
      source,
    }),
  );
  await vi.waitFor(() => expect(said[0]?.type).toBe("setup"));
  return { port, said };
}

const dialog = () =>
  container.querySelector('[role="dialog"][data-state="open"]');
const dialogTitle = () => dialog()?.querySelector("h2")?.textContent;

async function send(port: MessagePort, message: FromFrame) {
  await act(async () => {
    port.postMessage(message);
  });
}

async function waitFor(assert: () => void) {
  await vi.waitFor(async () => act(async () => assert()));
}

it("opens the selected speaker and keeps its detail open when the frame asks for another", async () => {
  const { port, said } = await connect();
  await send(port, { type: "openDevice", device: "office" });
  await waitFor(() => expect(dialogTitle()).toBe("Office Speaker"));

  await send(port, { type: "openDevice", device: "hall" });
  await send(port, { type: "request", id: 1, op: "entities" });
  await waitFor(() =>
    expect(said).toContainEqual(
      expect.objectContaining({ type: "answer", id: 1 }),
    ),
  );
  expect(dialogTitle()).toBe("Office Speaker");
});

it("opens Add devices and restores Setup's Try it parameters on return", async () => {
  const { port, said } = await connect();
  await send(port, { type: "open", page: "setup", params: {} });
  await waitFor(() =>
    expect(said).toContainEqual({ type: "show", page: "setup", params: {} }),
  );

  await send(port, { type: "addDevices", returnParams: { step: "try" } });
  await waitFor(() => {
    expect(pageTitle()).toBe("Devices");
    expect(dialogTitle()).toBe("Add devices");
  });
  await act(async () => {
    [...dialog()!.querySelectorAll("button")]
      .find((button) => button.textContent === "Done")!
      .click();
  });
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Back to Example"]')!
      .click();
  });
  const returned = await connect();
  expect(returned.said[0]).toMatchObject({
    type: "setup",
    page: "setup",
    params: { step: "try" },
  });
});

it("discards a speaker lookup from a page that has been left", async () => {
  const pending = deferred<DeviceInfo[]>();
  lookup = pending.promise;
  const { port, said } = await connect();
  await send(port, { type: "openDevice", device: "office" });
  await send(port, { type: "open", page: "setup", params: {} });
  await waitFor(() =>
    expect(said).toContainEqual({ type: "show", page: "setup", params: {} }),
  );
  expect(mockCoreJson).toHaveBeenCalledWith("/api/devices", { app: app.id });

  await act(async () => pending.resolve(speakers));
  expect(dialog()).toBeNull();
});
