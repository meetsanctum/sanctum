// @vitest-environment jsdom
import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { AppScope, type AppClient } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DeviceFacts } from "../../src/facts";
import ui from "../../src/ui/index";

// ESPHome's page in a device's detail: how the device is reached, whether
// its connection is encrypted, what it runs, its signal, and what it has
// that the app doesn't bring in.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const device = { id: "device:1", availability: "online" } as DeviceInfo;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function show(facts: DeviceFacts | Error) {
  const client = {
    async call(id: string, input: unknown) {
      expect([id, input]).toEqual(["esphome.device", { device: "device:1" }]);
      if (facts instanceof Error) throw facts;
      return facts;
    },
  } as unknown as AppClient;
  const Page = ui.devicePages!["esphome.device"]!;
  await act(async () => {
    root.render(
      <AppScope client={client}>
        <Page device={device} />
      </AppScope>,
    );
  });
}

const rows = () =>
  [...host.querySelectorAll("dt")].map((label) => [
    label.textContent,
    label.nextElementSibling?.textContent,
  ]);

describe("ESPHome's device page", () => {
  it("explains how to retry a failed connection load", async () => {
    await show(new Error("offline"));

    const alert = host.querySelector('[role="alert"]');
    expect(alert?.querySelector("[data-slot=alert-title]")?.textContent).toBe(
      "How it's connected didn't load",
    );
    expect(
      alert?.querySelector("[data-slot=alert-description]")?.textContent,
    ).toBe("Close its detail and open it again.");
  });

  it("says how an encrypted device is reached and what else it has", async () => {
    await show({
      address: "192.168.1.40:6053",
      encrypted: true,
      version: "2026.10.2",
      signal: -58,
      unused: ["Display brightness", "Restart"],
      sleeps: false,
      firstKey: null,
    });

    expect(rows()).toEqual([
      ["Address", "192.168.1.40"],
      ["Connection", "Encrypted"],
      ["Firmware", "ESPHome 2026.10.2"],
      ["Wi-Fi", "Good, −58 dBm"],
    ]);
    expect(host.textContent).toContain(
      "It also has Display brightness and Restart, which this app doesn't bring into your home.",
    );
  });

  it("says nothing of how older firmware got its first key", async () => {
    await show({
      address: "192.168.1.42:6053",
      encrypted: true,
      version: "2026.6.0",
      signal: -60,
      unused: [],
      sleeps: false,
      firstKey: "setup",
    });

    expect(host.textContent).toContain("Encrypted");
    expect(host.textContent).not.toContain("key");
  });

  it("says in red when a device's connection isn't encrypted", async () => {
    await show({
      address: "192.168.1.41:6053",
      encrypted: false,
      version: null,
      signal: -80,
      unused: [],
      sleeps: false,
      firstKey: null,
    });

    const connection = [...host.querySelectorAll("dd")].find(
      (each) => each.textContent === "Not encrypted",
    );
    expect(connection?.className).toContain("text-destructive");
    expect(rows().map(([label]) => label)).toEqual([
      "Address",
      "Connection",
      "Wi-Fi",
    ]);
    expect(host.textContent).toContain("Weak, −80 dBm");
    expect(host.textContent).not.toContain("It also has");
  });
});
