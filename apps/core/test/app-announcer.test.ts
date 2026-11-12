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
// As its supervisor has it, given up on after failing.
const supervision = {
  phase: "failed" as const,
  since: new Date("2026-11-13T12:00:00.000Z"),
  isFirstStart: false,
  failures: [],
  quiet: false,
  attention: false,
};

it("logs a listener that fails, and goes on", () => {
  const logs: string[] = [];
  const announce = announcerOf(
    () => {
      throw new Error("socket gone");
    },
    (line) => logs.push(line),
  );

  expect(() =>
    announce({ manifest, granted: [], settings: null, supervision }),
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
  )({ manifest, granted: [], settings: null, supervision });

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
    supervision,
  });
  expect(heard).toEqual([
    expect.objectContaining({ id: "test.plain", state: "failed" }),
  ]);
});
