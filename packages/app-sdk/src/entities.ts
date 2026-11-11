import type { z } from "zod";

import type { WidgetDefinition } from "./widgets.js";

// What an app brings to the home, declared in its manifest under `provides`:
// entities of its declared types, which the app publishes and the core keeps
// and serves, and widgets, whose cards it publishes as entities of the
// widget's own type (widgets.ts).
// Other apps read entities by standard type only, through the core, so they
// depend on a type and never on an app.

export interface EntityTypeDefinition<State extends z.ZodType = z.ZodType> {
  /**
   * A standard type's id, such as weather.forecast, or the app's own,
   * namespaced like its actions, such as naturalLight.target.
   */
  readonly id: string;
  readonly title: string;
  /** What an entity of this type holds. The core checks every state an app publishes against it. */
  readonly state: State;
  /** Set on the core's standard types only (weather.ts), which apps read with entities.read:<type>. */
  readonly standard?: boolean;
}

export function defineEntityType<State extends z.ZodType>(
  type: EntityTypeDefinition<State>,
): EntityTypeDefinition<State> {
  return type;
}

/** The permission to read the entities of a standard type, such as entities.read:sun. */
export const entityReadPermission = (type: string) => `entities.read:${type}`;

/** What an app publishes for one of its entities, by its own key. */
export type EntityPublication = {
  /** One of the types the app declares under provides. */
  type: string;
  key: string;
  name: string;
  state: unknown;
};

/** An entity as the core keeps it: what clients and apps read. */
export type EntityInfo<State = unknown> = {
  /** The app that brings it. */
  app: string;
  /** The app's own key for it. */
  key: string;
  type: string;
  name: string;
  state: State;
  updatedAt: string;
};

/** Everything an app brings to the home, declared so the core can list it without running the app. */
export interface Provides {
  readonly entities?: readonly EntityTypeDefinition[];
  readonly widgets?: readonly WidgetDefinition[];
}
