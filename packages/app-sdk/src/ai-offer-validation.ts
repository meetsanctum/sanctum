import { z } from "zod";

import { aiAreas, assistantOfferSchema } from "./ai-agents.js";
import type { EntityTypeDefinition } from "./entities.js";
import type { ActionDefinition } from "./index.js";

export function assertAssistantOffers(
  actions: readonly ActionDefinition[],
  types: readonly EntityTypeDefinition[],
) {
  const items = [
    ...actions.map(({ id, tier, assistant }) => ({ id, tier, assistant })),
    ...types.map(({ id, assistant }) => ({ id, tier: "read", assistant })),
  ];
  const offers = new Map<string, readonly string[]>();
  for (const { id, tier, assistant } of items) {
    if (assistant === undefined) continue;
    if (offers.has(id))
      throw new Error(`Duplicate offer to AI agents id "${id}"`);
    const offer = assistantOfferSchema.safeParse(assistant);
    if (!offer.success) {
      throw new Error(
        `Invalid offer to AI agents for "${id}": ${z.prettifyError(offer.error)}`,
      );
    }
    if (tier !== "read" && tier !== "write") {
      throw new Error(
        `"${id}" can't be offered to AI agents: it must be read or write`,
      );
    }
    offers.set(id, offer.data.needs ?? []);
  }

  for (const [id, needs] of offers) {
    for (const need of needs) {
      const isArea = aiAreas.includes(need);
      const isOffer = offers.has(need);
      if (need === id || (!isArea && !isOffer)) {
        throw new Error(
          `"${id}" needs "${need}", which must name an area or another offer`,
        );
      }
      if (isArea && isOffer) {
        throw new Error(
          `"${id}" needs "${need}", which names both an area and an offer`,
        );
      }
    }
  }

  // Check each branch once, leaving only unchecked offers in the map.
  const visiting = new Set<string>();
  function checkNeeds(id: string) {
    const needs = offers.get(id);
    if (!needs) return;
    if (visiting.has(id))
      throw new Error(`"${id}" has a circular AI offer dependency`);
    visiting.add(id);
    for (const need of needs) checkNeeds(need);
    visiting.delete(id);
    offers.delete(id);
  }
  for (const id of offers.keys()) checkNeeds(id);
}
