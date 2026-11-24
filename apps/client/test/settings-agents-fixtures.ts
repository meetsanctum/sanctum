import type { AiCanUse, AppInfo } from "@meetsanctum/app-sdk";

export const example: AppInfo = {
  id: "sanctum.example",
  name: "Example",
  version: "1.0.0",
  icon: null,
  pages: [],
  requests: [],
  permissions: [],
  state: "running",
  settings: null,
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
};

// An app acting as the household's AI assistant.
export const assistant: AppInfo = {
  ...example,
  id: "sanctum.example-assistant",
  name: "Assistant",
  requests: [
    {
      id: "ai.assistant",
      reason: "To do what you ask.",
      needed: true,
      asked: null,
      startsOn: false,
    },
  ],
  permissions: ["ai.assistant"],
};

export function canUseWith(
  changes: Partial<Record<string, boolean>> = {},
): AiCanUse {
  const area = (id: string, on: boolean, always = false) => ({
    id,
    on: changes[id] ?? on,
    always,
  });
  const offer = (
    id: string,
    title: string,
    on: boolean,
    kind: "action" | "entity",
    tier: "read" | "write",
    missing: string[] = [],
  ) => ({
    app: example.id,
    id,
    kind,
    tier,
    title,
    description: "Written for an AI agent.",
    on: changes[id] ?? on,
    needs: missing,
    missing,
  });
  return {
    areas: [
      area("places.read", true, true),
      area("devices.control:light", true),
      area("devices.read:switch", true),
      area("devices.read:motion", false),
      area("people.read", false),
    ],
    offers: [
      offer("example.run", "Run a scene", true, "action", "write"),
      offer("example.create", "Create a scene", false, "action", "write", [
        "devices.control:switch",
      ]),
      offer("example.scene", "Scenes in each room", true, "entity", "read"),
    ],
  };
}
