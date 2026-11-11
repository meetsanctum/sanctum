import type { ActivityInfo } from "@meetsanctum/app-sdk";

// Entries of the activity log as the core answers them, for the client's
// tests: a command by default, by Alex, about the lamp.

export const alex = {
  kind: "person" as const,
  id: "alex",
  name: "Alex",
  colour: "#B9DEFC",
  avatar: null,
};

export function entry(fields: Partial<ActivityInfo> = {}): ActivityInfo {
  return {
    id: "entry-1",
    at: "2026-10-31T21:52:00.000Z",
    firstAt: null,
    count: 1,
    kind: "devices",
    source: "devices",
    action: "device.command",
    title: null,
    outcome: "ok",
    reason: null,
    detail: { capability: "light", asked: { on: true, brightness: 80 } },
    who: alex,
    app: null,
    run: null,
    subject: { type: "device", id: "lamp", name: "Lamp", gone: false },
    causeId: null,
    caused: null,
    ...fields,
  };
}
