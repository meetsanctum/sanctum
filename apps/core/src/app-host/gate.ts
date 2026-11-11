import {
  householdTiers,
  type ActionDefinition,
  type Actor,
} from "@meetsanctum/app-sdk";

import type { Principal } from "../auth/clients.js";
import type { People } from "../people/people.js";
import { ActionCallError } from "./errors.js";

// The permission gate: turns the principal behind a request into the actor
// an action runs as, and refuses what that actor may not do. There are no
// roles or permissions between people: every person and every shared client
// may do everything. What runs with no person behind it is held to the
// everyday tiers. Device commands pass the same gate, with their
// capability's tier.

// What the gate weighs: an action, or a device capability's commands.
export type Rule = Pick<ActionDefinition, "tier">;

export function createGate(people: People) {
  // Refuses what an actor may not do.
  function permit(actor: Actor, rule: Rule) {
    switch (actor.kind) {
      // A shared client acts as the household, never as a person.
      case "client":
        return;
      // Someone removed from the household is refused at once.
      case "user":
        if (!people.get(actor.id)) {
          throw new ActionCallError("forbidden");
        }
        return;
      // An app acting on its own, from its lifecycle hooks and jobs, and a
      // workflow, which acts for the household whoever made it, do the
      // everyday things; the rest needs a person's approval.
      case "app":
      case "workflow":
        if (!householdTiers.includes(rule.tier)) {
          throw new ActionCallError("needs_approval");
        }
        return;
      // Any other actor is refused.
      default:
        throw new ActionCallError("forbidden");
    }
  }

  return {
    // The actor for this call, or an ActionCallError.
    admit(principal: Principal, rule: Rule): Actor {
      // Widget tokens read widget data and nothing else.
      if (principal.scope !== "full") {
        throw new ActionCallError("forbidden");
      }
      // A personal client acts as its person.
      const actor: Actor =
        principal.client.kind === "shared"
          ? { kind: "client", id: principal.client.id }
          : { kind: "user", id: principal.person?.id ?? "" };
      if (actor.kind === "user" && !actor.id) {
        throw new ActionCallError("forbidden");
      }
      permit(actor, rule);
      return actor;
    },

    // For an actor already admitted, such as the one behind an action that
    // commands a device.
    permit,
  };
}

export type Gate = ReturnType<typeof createGate>;
