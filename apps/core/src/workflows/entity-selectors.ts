import { moodType, type EntityInfo } from "@meetsanctum/app-sdk";

import type { Entities } from "../entities/entities.js";

const previousMoodType = "moods.mood";
const moodsApp = "sanctum.moods";

// Saved selectors for Moods keep matching that app's moods after it adopts
// the standard type. A type-only selector keeps its original scope.
export function matchesEntityType(
  type: string | undefined,
  entity: Pick<EntityInfo, "app" | "type">,
) {
  return (
    type === undefined ||
    entity.type === type ||
    (type === previousMoodType &&
      entity.app === moodsApp &&
      entity.type === moodType.id)
  );
}

export function entitiesOfType(
  entities: Pick<Entities, "list">,
  type: string | undefined,
) {
  const listed = entities.list({ type });
  return type === previousMoodType
    ? [...listed, ...entities.list({ app: moodsApp, type: moodType.id })]
    : listed;
}
