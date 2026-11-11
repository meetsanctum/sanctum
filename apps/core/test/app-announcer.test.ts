import { defineApp, toStaticManifest } from "@meetsanctum/app-sdk";
import { expect, it } from "vitest";

import { announcerOf } from "../src/app-host/app-info.js";

// Telling clients an app changed (app-info.ts): a listener that fails is
// logged, and never fails the change it announces.

const manifest = toStaticManifest(
  defineApp({
    id: "test.plain",
    name: "Plain",
    version: "0.1.0",
    core: "^1.0.0",
    permissions: [],
    actions: [],
    events: [],
  }),
);

it("logs a listener that fails, and goes on", () => {
  const logs: string[] = [];
  const announce = announcerOf(
    () => {
      throw new Error("socket gone");
    },
    (line) => logs.push(line),
  );

  expect(() =>
    announce({ manifest, granted: [], settings: null, stopFailed: true }),
  ).not.toThrow();
  expect(logs).toEqual([
    "apps: test.plain's change was not announced (socket gone)",
  ]);
});

it("logs a listener's promise that rejects", async () => {
  const logs: string[] = [];
  announcerOf(
    async () => {
      throw new Error("later");
    },
    (line) => logs.push(line),
  )({ manifest, granted: [], settings: null, stopFailed: true });

  await expect
    .poll(() => logs)
    .toEqual(["apps: test.plain's change was not announced (later)"]);
});

it("hands a listener the app as clients see it", () => {
  const heard: unknown[] = [];
  announcerOf(
    (info) => {
      heard.push(info);
    },
    () => {},
  )({
    manifest,
    granted: [],
    settings: null,
    stopFailed: true,
  });
  expect(heard).toEqual([
    expect.objectContaining({ id: "test.plain", state: "stopped" }),
  ]);
});
